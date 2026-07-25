import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RECONNECT_DELAY_MS,
  calculateServerElapsedMs,
  formatAge,
  formatDistance,
  getSequenceShortcutAction,
  groupStepsByScene,
  isDemoMode,
  loadDemoSequence,
  makePongMessage,
  makeMusicToggleMessage,
  makeUnassignedRenderKey,
  makeWebSocketUrl,
  needsJumpConfirmation,
  normalizeCueParams,
  parseFramePayload,
  reconcileRoleOwners,
  scrollCueRowIntoView
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
  assert.equal(formatDistance(0), "0.0 cm");
  assert.equal(formatDistance(1.234), "123.4 cm");
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

test("calculates elapsed server time with the last known clock offset", () => {
  assert.equal(calculateServerElapsedMs(9_500, 8_750, 2_000), 1_250);
  assert.equal(calculateServerElapsedMs(12_000, 8_750, 2_000), 0);
  assert.equal(calculateServerElapsedMs(null, 8_750, 2_000), null);
  assert.equal(
    calculateServerElapsedMs(9_500, Number.NaN, 2_000),
    null
  );
});

test("groups cue steps by sceneId while preserving order and cue ranges", () => {
  const groups = groupStepsByScene([
    {
      stepId: "s1-001",
      params: {
        sceneId: "s1",
        scene: "첫 장면",
        cueNumber: 1,
        speaker: "A",
        lines: ["첫 큐"]
      }
    },
    {
      stepId: "s1-002",
      params: {
        sceneId: "s1",
        scene: "첫 장면",
        cueNumber: 2,
        speaker: "A",
        lines: ["둘째 큐"]
      }
    },
    {
      stepId: "s2-010",
      params: {
        sceneId: "s2",
        scene: "둘째 장면",
        cueNumber: 10,
        speaker: "B",
        textKr: "다음 장면"
      }
    },
    { stepId: "legacy", params: { speaker: "A", lines: ["구형 큐"] } }
  ]);

  assert.deepEqual(
    groups.map((group) => ({
      sceneId: group.sceneId,
      scene: group.scene,
      startCueNumber: group.startCueNumber,
      endCueNumber: group.endCueNumber,
      stepIndexes: group.entries.map((entry) => entry.stepIndex)
    })),
    [
      {
        sceneId: "s1",
        scene: "첫 장면",
        startCueNumber: 1,
        endCueNumber: 2,
        stepIndexes: [0, 1]
      },
      {
        sceneId: "s2",
        scene: "둘째 장면",
        startCueNumber: 10,
        endCueNumber: 10,
        stepIndexes: [2]
      },
      {
        sceneId: "__ungrouped__",
        scene: "씬 미지정",
        startCueNumber: null,
        endCueNumber: null,
        stepIndexes: [3]
      }
    ]
  );
});

test("requires one confirmation only for jumps of two or more indexes", () => {
  assert.equal(needsJumpConfirmation(4, 4), false);
  assert.equal(needsJumpConfirmation(4, 5), false);
  assert.equal(needsJumpConfirmation(4, 6), true);
  assert.equal(needsJumpConfirmation(6, 4), true);
  assert.equal(needsJumpConfirmation(null, 4), false);
});

test("builds music play and stop commands from the current track state", () => {
  assert.deepEqual(
    makeMusicToggleMessage({ trackId: "amb", playing: false }),
    { t: "musicCommand", trackId: "amb", action: "play" }
  );
  assert.deepEqual(
    makeMusicToggleMessage({ trackId: "amb", playing: true }),
    { t: "musicCommand", trackId: "amb", action: "stop" }
  );
  assert.equal(makeMusicToggleMessage(null), null);
  assert.equal(makeMusicToggleMessage({ trackId: "" }), null);
});

test("normalizes missing and legacy cue params without throwing", () => {
  assert.deepEqual(normalizeCueParams(null), {
    cueNumber: null,
    scene: "",
    sceneId: "",
    speaker: "",
    textKr: "",
    textEn: "",
    lines: [],
    xr: "",
    ui: "",
    vo: "",
    voDurationMs: null,
    sfx: "",
    musicCue: null,
    note: ""
  });

  assert.deepEqual(
    normalizeCueParams({
      speaker: "우경",
      lines: ["첫 줄", "둘째 줄"],
      voDurationMs: Number.NaN,
      musicCue: { trackId: "amb", action: "in", note: "지금" }
    }),
    {
      cueNumber: null,
      scene: "",
      sceneId: "",
      speaker: "우경",
      textKr: "첫 줄\n둘째 줄",
      textEn: "",
      lines: ["첫 줄", "둘째 줄"],
      xr: "",
      ui: "",
      vo: "",
      voDurationMs: null,
      sfx: "",
      musicCue: { trackId: "amb", action: "in", note: "지금" },
      note: ""
    }
  );

  assert.doesNotThrow(() =>
    normalizeCueParams({ lines: { malformed: true }, musicCue: "bad" })
  );
});

test("resolves operator shortcuts without browser globals", () => {
  assert.equal(getSequenceShortcutAction(" ", "DIV"), "next");
  assert.equal(getSequenceShortcutAction("ArrowRight", "BODY"), "next");
  assert.equal(getSequenceShortcutAction("ArrowLeft", "BUTTON"), "prev");
  assert.equal(getSequenceShortcutAction(" ", "BUTTON"), null);
  assert.equal(getSequenceShortcutAction(" ", "SUMMARY"), null);
  assert.equal(getSequenceShortcutAction(" ", "A"), null);
  assert.equal(getSequenceShortcutAction(" ", "DIV", false, true), null);
  assert.equal(getSequenceShortcutAction("ArrowRight", "INPUT"), null);
  assert.equal(getSequenceShortcutAction(" ", "textarea"), null);
  assert.equal(getSequenceShortcutAction("Escape", "BODY"), null);
});

test("recognizes demo mode only from demo=1", () => {
  assert.equal(isDemoMode("?demo=1"), true);
  assert.equal(isDemoMode("?foo=x&demo=1"), true);
  assert.equal(isDemoMode("?demo=0"), false);
  assert.equal(isDemoMode(""), false);
});

test("loads the canonical demo sequence from static or local read-only state", async () => {
  const canonical = {
    sequenceId: "canonical",
    music: [],
    steps: [{ stepId: "one", params: {} }]
  };
  const staticRequests = [];
  const fromStatic = await loadDemoSequence(async (url) => {
    staticRequests.push(url);
    return { ok: true, json: async () => canonical };
  });
  assert.equal(fromStatic.sequenceId, "canonical");
  assert.deepEqual(staticRequests, ["./data/sequence.json"]);

  const localRequests = [];
  const fromLocalState = await loadDemoSequence(async (url) => {
    localRequests.push(url);
    return url === "./data/sequence.json"
      ? { ok: false, status: 404 }
      : { ok: true, json: async () => ({ sequence: canonical }) };
  });
  assert.equal(fromLocalState.sequenceId, "canonical");
  assert.deepEqual(localRequests, [
    "./data/sequence.json",
    "./api/state"
  ]);

  const fallback = {
    sequenceId: "fallback",
    music: [],
    steps: [{ stepId: "fallback-one", params: {} }]
  };
  const fallbackResult = await loadDemoSequence(
    async () => {
      throw new Error("offline");
    },
    fallback
  );
  assert.equal(fallbackResult, fallback);
});

test("scrolls the current cue inside its list without moving outer views", () => {
  const outerScroller = { scrollLeft: 4, scrollTop: 30 };
  const viewport = {
    scrollX: 7,
    scrollY: 11,
    scrollTo(left, top) {
      this.scrollX = left;
      this.scrollY = top;
    }
  };
  let receivedOptions = null;
  const currentRow = {
    scrollIntoView(options) {
      receivedOptions = options;
      outerScroller.scrollLeft = 400;
      outerScroller.scrollTop = 900;
      viewport.scrollX = 70;
      viewport.scrollY = 110;
    }
  };

  assert.equal(
    scrollCueRowIntoView(currentRow, [outerScroller], viewport),
    true
  );
  assert.deepEqual(receivedOptions, { block: "nearest" });
  assert.deepEqual(outerScroller, { scrollLeft: 4, scrollTop: 30 });
  assert.equal(viewport.scrollX, 7);
  assert.equal(viewport.scrollY, 11);
  assert.equal(scrollCueRowIntoView(null, [outerScroller], viewport), false);
});

test("provides semantic A/B, unassigned, sequence, and preview-control hooks", async () => {
  const html = await readFile(htmlPath, "utf8");

  for (const hook of [
    'data-role-card="A"',
    'data-role-card="B"',
    'data-action="request-frame"',
    'id="unassigned-devices"',
    'id="sequence-panel"',
    'id="sequence-steps"',
    'id="music-channels"',
    'id="cue-sheet"',
    'data-cue-panel="now"',
    'data-cue-panel="deck"',
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
  assert.match(html, />◀ PREV</);
  assert.match(html, />▶▶ NEXT CUE</);
  for (const label of [
    "🥽 XR",
    "🖥 UI",
    "🔊 V.O",
    "🔈 SFX",
    "🎵 음악",
    "📝 비고"
  ]) {
    assert.match(html, new RegExp(label), `missing cue label: ${label}`);
  }
});

test("keeps each role device identity outside collapsed health details", async () => {
  const html = await readFile(htmlPath, "utf8");

  for (const role of ["A", "B"]) {
    const card = html.match(
      new RegExp(
        `<article[^>]*data-role-card="${role}"[\\s\\S]*?</article>`
      )
    )?.[0];

    assert.ok(card, `missing role ${role} card`);
    assert.match(
      card,
      new RegExp(`<h2 id="role-${role.toLowerCase()}-title"`),
      `role ${role} must preserve its original h2 title markup`
    );
    assert.equal(
      (card.match(/data-field="device-id"/g) ?? []).length,
      1,
      `role ${role} must contain exactly one device-id field`
    );
    assert.ok(
      card.indexOf('data-field="device-id"') <
        card.indexOf(`data-health-details="${role}"`),
      `role ${role} device-id must precede its collapsed health details`
    );
  }
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
    /\.cue-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s
  );
  assert.match(
    css,
    /\.next-cue\s*\{[^}]*min-height:\s*64px;/s
  );
  assert.match(
    css,
    /\.preview-stage img\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*object-fit:\s*contain;/s
  );
  assert.match(
    css,
    /\.sequence-steps\s*\{[^}]*display:\s*grid;[^}]*max-height:[^;]+;[^}]*overflow-y:\s*auto;/s
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
  assert.match(
    css,
    /@media\s*\(max-width:\s*760px\)[^{]*\{[\s\S]*?\.cue-grid\s*\{[^}]*grid-template-columns:\s*1fr;/s
  );
});

test("lays out V.O status before auto-scrolling the current cue row", async () => {
  const source = await readFile(appPath, "utf8");
  const renderer = source.match(
    /function renderSequence\(\)\s*\{[\s\S]*?\n  \}\n\n  function applyDevices/
  )?.[0];

  assert.ok(renderer, "missing sequence renderer");
  assert.ok(
    renderer.indexOf("renderVoProgress();") <
      renderer.indexOf("renderCueSheet();"),
    "V.O visibility must settle before cue-sheet scrolling"
  );
  assert.match(
    source,
    /scrollCueRowIntoView\(\s*currentRow,\s*\[document\.querySelector\("\.console-main"\)\],\s*window\s*\);/
  );
});

test("toggles health details through the delegated click handler", async () => {
  const source = await readFile(appPath, "utf8");
  const clickHandler = source.match(
    /function handleClick\(event\)\s*\{[\s\S]*?\n  \}\n\n  function teardown/
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
