import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RECONNECT_DELAY_MS,
  formatAge,
  formatDistance,
  makePongMessage,
  makeUnassignedRenderKey,
  makeWebSocketUrl,
  parseFramePayload,
  reconcileRoleOwners
} from "../public/app.js";

const htmlPath = new URL("../public/index.html", import.meta.url);
const appPath = new URL("../public/app.js", import.meta.url);

test("maps same-origin HTTP and HTTPS locations to the /ws WebSocket URL", () => {
  assert.equal(
    makeWebSocketUrl({ protocol: "http:", host: "192.168.0.8:8080" }),
    "ws://192.168.0.8:8080/ws"
  );
  assert.equal(
    makeWebSocketUrl({ protocol: "https:", host: "venue.example" }),
    "wss://venue.example/ws"
  );
});

test("uses the exact two-second reconnect delay", () => {
  assert.equal(RECONNECT_DELAY_MS, 2000);
});

test("builds the required dashboard pong with an echoed server timestamp", () => {
  assert.deepEqual(makePongMessage(12_345, 67_890), {
    t: "pong",
    clientTimeMs: 67_890,
    echoedServerTimeMs: 12_345
  });
});

test("formats distances with two decimals and unavailable values as an em dash", () => {
  assert.equal(formatDistance(0), "0.00 m");
  assert.equal(formatDistance(1.234), "1.23 m");
  assert.equal(formatDistance(null), "—");
  assert.equal(formatDistance(Number.NaN), "—");
  assert.equal(formatDistance(-1), "—");
});

test("formats relative ages in whole seconds and clamps clock skew", () => {
  assert.equal(formatAge(null, 12_500), "—");
  assert.equal(formatAge(10_000, 12_499), "2초 전");
  assert.equal(formatAge(13_000, 12_500), "0초 전");
});

test("parses the role byte and JPEG bytes without browser globals", () => {
  const payloadA = parseFramePayload(
    Uint8Array.from([0x41, 0xff, 0xd8, 0xff]).buffer
  );
  assert.equal(payloadA.role, "A");
  assert.deepEqual([...payloadA.jpegBytes], [0xff, 0xd8, 0xff]);

  const source = Uint8Array.from([9, 0x42, 1, 2, 3, 9]);
  const payloadB = parseFramePayload(source.subarray(1, 5));
  assert.equal(payloadB.role, "B");
  assert.deepEqual([...payloadB.jpegBytes], [1, 2, 3]);

  assert.equal(parseFramePayload(Uint8Array.from([0x43, 1]).buffer), null);
  assert.equal(parseFramePayload(Uint8Array.from([0x41]).buffer), null);
});

test("identifies previews made stale by reassignment, theft, and unassignment", () => {
  assert.deepEqual(
    reconcileRoleOwners(
      { A: "quest-old-a", B: "quest-old-b" },
      [
        { deviceId: "quest-new-a", role: "A" },
        { deviceId: "quest-old-a", role: "B" }
      ]
    ),
    {
      owners: { A: "quest-new-a", B: "quest-old-a" },
      staleRoles: ["A", "B"]
    }
  );

  assert.deepEqual(
    reconcileRoleOwners(
      { A: "quest-a", B: "quest-b" },
      [{ deviceId: "quest-a", role: "A" }]
    ),
    {
      owners: { A: "quest-a", B: null },
      staleRoles: ["B"]
    }
  );

  assert.deepEqual(
    reconcileRoleOwners(
      { A: "quest-a", B: null },
      [{ deviceId: "quest-a", role: "A" }]
    ),
    {
      owners: { A: "quest-a", B: null },
      staleRoles: []
    }
  );
});

test("keeps the unassigned render key stable across telemetry-only pushes", () => {
  const previous = [
    {
      deviceId: "quest-free",
      role: null,
      online: true,
      rttMs: 5,
      lastHealth: { fps: 72 }
    },
    { deviceId: "quest-a", role: "A", online: true }
  ];
  const telemetryUpdate = [
    {
      deviceId: "quest-free",
      role: null,
      online: true,
      rttMs: 9,
      lastHealth: { fps: 70 }
    },
    { deviceId: "quest-a", role: "A", online: false }
  ];

  assert.equal(
    makeUnassignedRenderKey(previous, "connected"),
    makeUnassignedRenderKey(telemetryUpdate, "connected")
  );
  assert.notEqual(
    makeUnassignedRenderKey(previous, "connected"),
    makeUnassignedRenderKey(
      [{ deviceId: "quest-free", role: null, online: false }],
      "connected"
    )
  );
  assert.notEqual(
    makeUnassignedRenderKey(previous, "connected"),
    makeUnassignedRenderKey(previous, "disconnected")
  );
});

test("provides semantic A/B, unassigned, sequence, and preview-control hooks", async () => {
  const html = await readFile(htmlPath, "utf8");

  for (const hook of [
    'data-role-card="A"',
    'data-role-card="B"',
    'data-preview-source="A"',
    'data-preview-source="B"',
    'id="unassigned-devices"',
    'id="sequence-panel"',
    'id="sequence-steps"',
    'data-seq-action="start"',
    'data-seq-action="stop"',
    'data-seq-action="prev"',
    'data-seq-action="next"'
  ]) {
    assert.match(html, new RegExp(hook), `missing hook: ${hook}`);
  }
});

test("loads one local module script and contains no external references", async () => {
  const html = await readFile(htmlPath, "utf8");
  const scripts = html.match(/<script\b/gi) ?? [];

  assert.equal(scripts.length, 1);
  assert.match(
    html,
    /<script\s+type=["']module["']\s+src=["']\.\/app\.js["']><\/script>/
  );
  assert.doesNotMatch(
    html,
    /(?:https?:)?\/\/|src=["']\/\//i,
    "dashboard must remain fully offline"
  );
});

test("never uses innerHTML for device-supplied dashboard content", async () => {
  const source = await readFile(appPath, "utf8");
  assert.doesNotMatch(source, /\.innerHTML\b|insertAdjacentHTML\b/);
});
