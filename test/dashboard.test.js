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
const stylePath = new URL("../public/style.css", import.meta.url);

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

test("provides the compact cue-console structure and labels", async () => {
  const html = await readFile(htmlPath, "utf8");

  assert.match(html, /class="[^"]*\boperator-bar\b/);
  assert.match(html, /id="health-a-details"[^>]*\bhidden\b/);
  assert.match(html, /id="health-b-details"[^>]*\bhidden\b/);
  assert.match(
    html,
    /data-action="toggle-health"[^>]*aria-expanded="false"/
  );
  assert.match(html, /id="unassigned-banner"[^>]*\bhidden\b/);
  assert.match(html, />⏵ Start</);
  assert.match(html, />⏹ Stop</);
  assert.match(html, />◀ Prev</);
  assert.match(html, />▶ Next</);
});

test("constrains the desktop console and restores mobile scrolling", async () => {
  const css = await readFile(stylePath, "utf8");

  assert.match(
    css,
    /body\s*\{[^}]*min-height:\s*100dvh;[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;[^}]*display:\s*grid;[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\);/s
  );
  assert.match(
    css,
    /\.role-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s
  );
  assert.match(
    css,
    /\.preview-stage img\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*object-fit:\s*contain;/s
  );
  assert.match(
    css,
    /\.sequence-steps\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;/s
  );
  assert.match(
    css,
    /\.health-details:not\(\[hidden\]\)\s*\{[^}]*position:\s*absolute;/s
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*760px\)[^{]*\{[\s\S]*?body\s*\{[^}]*height:\s*auto;[^}]*overflow-y:\s*auto;/s
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*760px\)[^{]*\{[\s\S]*?\.operator-bar\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:\s*20;/s
  );
});

test("toggles health details through the delegated click handler", async () => {
  const source = await readFile(appPath, "utf8");
  const clickHandler = source.match(
    /function handleClick\(event\)\s*\{[\s\S]*?\n  \}\n\n  function handleChange/
  )?.[0];

  assert.ok(clickHandler, "missing delegated click handler");
  assert.match(
    clickHandler,
    /button\.dataset\.action === "toggle-health"/
  );
  assert.match(clickHandler, /const expanded = details\.hidden;/);
  assert.match(clickHandler, /details\.hidden = !expanded;/);
  assert.match(
    clickHandler,
    /button\.setAttribute\("aria-expanded", String\(expanded\)\);/
  );
  assert.match(
    clickHandler,
    /button\.textContent = expanded \? "상세 ▴" : "상세 ▾";/
  );
  assert.doesNotMatch(source, /(?:local|session)Storage/);
  assert.equal(
    (source.match(/\bsetInterval\s*\(/g) ?? []).length,
    1,
    "health toggles must not add another interval"
  );
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
