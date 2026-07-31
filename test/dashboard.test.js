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
  makeSubtitleToggleMessage,
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
const htmlVoidElements = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);

function directChildOpeningTags(html, parentPattern) {
  const parent = html.match(parentPattern);
  if (!parent || parent.index === undefined) {
    return [];
  }

  const parentTag = parent[0].match(/^<([a-z][\w:-]*)\b/i)?.[1]?.toLowerCase();
  const tagPattern =
    /<!--[\s\S]*?-->|<![^>]*>|<\/?([a-z][\w:-]*)\b[^>]*>/gi;
  tagPattern.lastIndex = parent.index + parent[0].length;
  const children = [];
  let depth = 0;
  let match;

  while ((match = tagPattern.exec(html)) !== null) {
    if (!match[1]) {
      continue;
    }
    const opening = match[0];
    const tag = match[1].toLowerCase();
    if (opening.startsWith("</")) {
      if (depth === 0 && tag === parentTag) {
        return children;
      }
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth === 0) {
      children.push(opening);
    }
    if (!htmlVoidElements.has(tag) && !opening.endsWith("/>")) {
      depth += 1;
    }
  }

  return children;
}

function openingTagShape(opening) {
  const tag = opening.match(/^<([a-z][\w:-]*)\b/i)?.[1]?.toLowerCase();
  const id = opening.match(/\bid="([^"]*)"/i)?.[1] ?? null;
  const classNames =
    opening
      .match(/\bclass="([^"]*)"/i)?.[1]
      ?.trim()
      .split(/\s+/)
      .filter(Boolean) ?? [];
  return { tag, id, classNames };
}

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

test("builds Mandarin subtitle commands by inverting the current state", () => {
  assert.deepEqual(makeSubtitleToggleMessage(true), {
    t: "subtitleCommand",
    lang: "zh",
    enabled: false
  });
  assert.deepEqual(makeSubtitleToggleMessage(false), {
    t: "subtitleCommand",
    lang: "zh",
    enabled: true
  });
});

test("normalizes missing and legacy cue params without throwing", () => {
  assert.deepEqual(normalizeCueParams(null), {
    cueNumber: null,
    scene: "",
    sceneId: "",
    speaker: "",
    textKr: "",
    textEn: "",
    textZh: "",
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
      textZh: "第一行\n第二行",
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
      textZh: "第一行\n第二行",
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
  assert.equal(normalizeCueParams({ textZh: 123 }).textZh, "");
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

  const embedded = await loadDemoSequence(async () => {
    throw new Error("offline");
  });
  assert.deepEqual(embedded.music, [
    {
      trackId: "father_1",
      label: "father_1 · 엠비언스",
      file: "father_1.mp3"
    },
    {
      trackId: "father_2",
      label: "father_2 · 흥미로운 음악",
      file: "father_2.mp3"
    },
    {
      trackId: "father_3",
      label: "father_3",
      file: "father_3.mp3"
    },
    {
      trackId: "mus_reunion",
      label: "추억속의 재회",
      file: "mus_추억속의재회.mp3"
    }
  ]);
  const embeddedTrackIds = new Set(
    embedded.music.map((track) => track.trackId)
  );
  assert.ok(
    embedded.steps.every(
      (step) =>
        typeof step.params?.textZh === "string" &&
        step.params.textZh.length > 0
    )
  );
  assert.ok(
    embedded.steps.every(
      (step) =>
        !step.params?.musicCue ||
        embeddedTrackIds.has(step.params.musicCue.trackId)
    )
  );
});

test("scrolls the current cue inside its list without moving outer views", () => {
  const cueSheetScroller = { scrollTop: 12 };
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
      cueSheetScroller.scrollTop = 240;
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
  assert.equal(cueSheetScroller.scrollTop, 240);
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
  const directChildren = directChildOpeningTags(
    html,
    /<main\b[^>]*class="[^"]*\bconsole-main\b[^"]*"[^>]*>/i
  ).map(openingTagShape);

  assert.deepEqual(
    directChildren,
    [
      {
        tag: "header",
        id: "sequence-panel",
        classNames: ["operator-bar"]
      },
      { tag: "section", id: null, classNames: ["cue-grid"] },
      {
        tag: "aside",
        id: "unassigned-banner",
        classNames: ["unassigned-banner"]
      },
      { tag: "section", id: "cue-sheet", classNames: ["cue-sheet"] },
      { tag: "section", id: null, classNames: ["devices-panel"] }
    ],
    "console main must contain exactly the approved five direct children"
  );
  assert.match(html, /class="[^"]*\boperator-bar\b/);
  assert.match(html, /id="health-a-details"[^>]*\bhidden\b/);
  assert.match(html, /id="health-b-details"[^>]*\bhidden\b/);
  assert.match(
    html,
    /data-action="toggle-health"[^>]*aria-expanded="false"/
  );
  assert.match(html, /id="unassigned-banner"[^>]*\bhidden\b/);
  assert.match(
    html,
    /<span class="eyebrow">VALUE ARCHIVE \*\*\* CUE OPERATOR<\/span>\s*0\. Transport/
  );
  assert.match(html, /<h1>1\. Now<\/h1>/);
  assert.match(html, /<h2>2\. Up Next<\/h2>/);
  assert.match(html, /<h2 id="cue-sheet-title">3\. Cue Sheet<\/h2>/);
  assert.match(html, /<h2 id="devices-title">4\. Quest Monitor<\/h2>/);
  assert.match(html, />START</);
  assert.match(html, />STOP</);
  assert.match(html, />PREV</);
  assert.match(html, />✱ NEXT CUE</);
  for (const label of [
    "❖ XR",
    "❖ UI",
    "❖ V.O",
    "❖ SFX",
    "❖ MUS",
    "❖ NOTE"
  ]) {
    assert.equal(
      (html.match(new RegExp(label, "g")) ?? []).length,
      2,
      `${label} must label both cue detail lists`
    );
  }
});

test("exposes the Mandarin subtitle control and ZH copy state in both cue panels", async () => {
  const [html, css] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(stylePath, "utf8")
  ]);
  const toggle = html.match(
    /<button\b[^>]*data-action="toggle-subtitle"[^>]*>[\s\S]*?<\/button>/
  )?.[0];
  const enabledToggle = css.match(
    /\.subtitle-toggle\[aria-pressed="true"\]\s*\{([^}]*)\}/s
  )?.[1];
  const zhCopy = css.match(
    /(?:^|\n)\.cue-copy__zh\s*\{([^}]*)\}/s
  )?.[1];
  const disabledZh = css.match(
    /\.cue-copy__zh\.is-disabled\s*\{([^}]*)\}/s
  )?.[1];

  assert.ok(toggle, "missing Mandarin subtitle toggle");
  assert.match(toggle, /\bdata-lang="zh"/);
  assert.match(toggle, /\bdata-server-control\b/);
  assert.match(toggle, /\baria-pressed="true"/);
  assert.match(toggle, /\bdisabled\b/);
  assert.match(toggle, /만다린 자막 ZH/);
  assert.equal(
    (html.match(/class="cue-copy__label">ZH<\/p>/g) ?? []).length,
    2
  );
  assert.equal(
    (html.match(/data-cue-field="text-zh"/g) ?? []).length,
    2
  );

  assert.ok(enabledToggle, "missing enabled subtitle-toggle state");
  assert.match(enabledToggle, /border-color:\s*var\(--invert-bg\);/);
  assert.match(enabledToggle, /background:\s*var\(--invert-bg\);/);
  assert.match(enabledToggle, /color:\s*var\(--invert-text\);/);
  assert.ok(zhCopy, "missing Mandarin cue-copy style");
  assert.match(zhCopy, /white-space:\s*pre-line;/);
  assert.ok(disabledZh, "missing disabled Mandarin cue-copy style");
  assert.match(disabledZh, /opacity:\s*[^;]+;/);
  assert.match(disabledZh, /color:\s*var\(--text-dim\);/);
  assert.match(disabledZh, /text-decoration:\s*line-through;/);
});

test("keeps static dashboard copy free of playback pictograms and emoji", async () => {
  const html = await readFile(htmlPath, "utf8");

  for (const symbol of [
    "⏵",
    "⏹",
    "◀",
    "▶",
    "🥽",
    "🖥",
    "🔊",
    "🔈",
    "🎵",
    "📝"
  ]) {
    assert.doesNotMatch(
      html,
      new RegExp(symbol, "u"),
      `static HTML must not contain ${symbol}`
    );
  }
});

test("keeps both cue panels' detail hooks while hiding rendered dashes", async () => {
  const html = await readFile(htmlPath, "utf8");
  const source = await readFile(appPath, "utf8");
  const setter = source.match(
    /function setCueField\(panel, name, value\)\s*\{[\s\S]*?\n  \}\n\n  function musicCueText/
  )?.[0];

  for (const name of ["xr", "ui", "vo", "sfx", "music", "note"]) {
    assert.equal(
      (html.match(new RegExp(`data-cue-field="${name}"`, "g")) ?? []).length,
      2,
      `${name} must remain addressable in NOW and ON DECK`
    );
  }
  assert.equal(
    (html.match(/data-vo-progress/g) ?? []).length,
    1,
    "NOW must retain its separate V.O progress section"
  );
  assert.ok(setter, "missing cue field renderer");
  assert.match(setter, /displayValue\(value\)/);
  assert.match(setter, /\.closest\("\.cue-details > div"\)/);
  assert.match(
    setter,
    /\.hidden\s*=\s*(?=[^;\n]*["']—["'])[^;\n]*(?:===|==)[^;\n]*;/
  );
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

test("uses the exact monochrome dark palette and local readable font stacks", async () => {
  const css = await readFile(stylePath, "utf8");
  const root = css.match(/:root\s*\{([^}]*)\}/s)?.[1];
  const body = css.match(/body\s*\{([^}]*)\}/s)?.[1];
  const codeTypography = css.match(
    /\.cue-position,\s*\.cue-row__cn,\s*\.music-button__status,\s*\.vo-progress__time,\s*\.status-badge,\s*\.cue-position__label,\s*\.scene-group__range,\s*\.telemetry-grid dd\s*\{([^}]*)\}/s
  )?.[1];
  const button = css.match(/button\s*\{([^}]*)\}/s)?.[1];

  assert.ok(root, "missing :root palette");
  assert.deepEqual(
    [...root.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(
      ([, name, value]) => `${name}: ${value.trim()};`
    ),
    [
      "--bg: #000000;",
      "--panel: #111111;",
      "--panel-raised: #1A1A1A;",
      "--line: #2E2E2E;",
      "--line-strong: #555555;",
      "--text: #FFFFFF;",
      "--text-dim: #969696;",
      "--invert-bg: #FFFFFF;",
      "--invert-text: #000000;"
    ]
  );
  assert.match(root, /color-scheme:\s*dark;/);
  assert.ok(body, "missing body rule");
  assert.match(
    body,
    /font-family:\s*"Pretendard",\s*"Pretendard Variable",\s*"Apple SD Gothic Neo",\s*"Malgun Gothic",\s*"Segoe UI",\s*system-ui,\s*sans-serif;/
  );
  assert.match(body, /background:\s*var\(--bg\);/);
  assert.ok(codeTypography, "missing scoped monospace typography rule");
  assert.match(
    codeTypography,
    /font-family:\s*"Consolas",\s*"SF Mono",\s*"Courier New",\s*monospace;/
  );
  assert.ok(button, "missing base button rule");
  assert.doesNotMatch(button, /text-transform:\s*uppercase;/);
  assert.doesNotMatch(button, /letter-spacing:/);
  assert.doesNotMatch(
    css,
    /--(?:paper|paper-dim|ink|ink-soft|frame|stamp|stamp-soft)\b/
  );
  assert.doesNotMatch(css, /@import\b|url\s*\(/i);
});

test("styles dark panels and high-priority states with monochrome inversion", async () => {
  const css = await readFile(stylePath, "utf8");
  const panels = css.match(
    /\.cue-panel,\s*\.cue-sheet,\s*\.devices-panel,\s*\.unassigned-banner,\s*\.role-card\s*\{([^}]*)\}/s
  )?.[1];
  const operator = css.match(/\.operator-bar\s*\{([^}]*)\}/s)?.[1];
  const nextCue = css.match(/\.next-cue\s*\{([^}]*)\}/s)?.[1];
  const playing = css.match(
    /\.music-button\.is-playing\s*\{([^}]*)\}/s
  )?.[1];
  const currentCue = css.match(
    /\.cue-row\.is-current,\s*\.cue-row\[aria-current="step"\]\s*\{([^}]*)\}/s
  )?.[1];

  assert.ok(panels, "missing shared dark-panel rule");
  assert.match(panels, /border:\s*1px solid var\(--line\);/);
  assert.match(panels, /background:\s*var\(--panel\);/);
  assert.match(panels, /color:\s*var\(--text\);/);
  assert.doesNotMatch(panels, /box-shadow:/);
  assert.doesNotMatch(css, /(?:backdrop-)?filter\s*:|text-shadow\s*:/i);

  assert.ok(operator, "missing operator bar rule");
  assert.match(operator, /border:\s*1px solid var\(--line-strong\);/);
  assert.match(operator, /background:\s*var\(--panel\);/);
  assert.match(operator, /color:\s*var\(--text\);/);

  assert.ok(nextCue, "missing next-cue rule");
  assert.match(nextCue, /min-height:\s*48px;/);
  assert.match(nextCue, /border-color:\s*var\(--invert-bg\);/);
  assert.match(nextCue, /background:\s*var\(--invert-bg\);/);
  assert.match(nextCue, /color:\s*var\(--invert-text\);/);
  assert.doesNotMatch(nextCue, /text-transform:\s*uppercase;/);
  assert.doesNotMatch(nextCue, /letter-spacing:/);

  assert.ok(playing, "missing playing music rule");
  assert.match(playing, /border-color:\s*var\(--invert-bg\);/);
  assert.match(playing, /background:\s*var\(--invert-bg\);/);
  assert.match(playing, /color:\s*var\(--invert-text\);/);
  assert.match(
    css,
    /\.music-button__cue\s*\{[^}]*border-top:\s*1px dashed var\(--text\);/s
  );

  assert.ok(currentCue, "missing current cue-sheet row rule");
  assert.match(currentCue, /border-color:\s*var\(--invert-bg\);/);
  assert.match(currentCue, /background:\s*var\(--invert-bg\);/);
  assert.match(currentCue, /color:\s*var\(--invert-text\);/);
  assert.match(currentCue, /padding-left:\s*1\.45rem;/);
  assert.match(
    css,
    /\.cue-row\.is-current::before,\s*\.cue-row\[aria-current="step"\]::before\s*\{[^}]*content:\s*"▶";[^}]*color:\s*var\(--invert-text\);/s
  );
});

test("replaces runtime emoji visually while retaining music track text", async () => {
  const css = await readFile(stylePath, "utf8");
  const musicChannels = css.match(
    /\.music-channels\s*\{([^}]*)\}/s
  )?.[1];
  const musicButton = css.match(/\.music-button\s*\{([^}]*)\}/s)?.[1];
  const musicLabel = css.match(
    /\.music-button__label\s*\{([^}]*)\}/s
  )?.[1];
  const musicLabelPrefix = css.match(
    /\.music-button__label::before\s*\{([^}]*)\}/s
  )?.[1];
  const musicStatus = css.match(
    /\.music-button__status\s*\{([^}]*)\}/s
  )?.[1];
  const cueIcons = css.match(/\.cue-row__icons\s*\{([^}]*)\}/s)?.[1];
  const cueIconsMark = css.match(
    /\.cue-row__icons::before\s*\{([^}]*)\}/s
  )?.[1];

  assert.ok(musicChannels, "missing music channel grid");
  assert.match(
    musicChannels,
    /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/
  );
  assert.ok(musicButton, "missing music button layout");
  assert.match(
    musicButton,
    /grid-template-columns:\s*minmax\(0,\s*1fr\);/
  );
  assert.ok(musicLabel, "missing runtime music-label mask");
  assert.match(musicLabel, /position:\s*relative;/);
  assert.match(musicLabel, /overflow:\s*hidden;/);
  assert.match(musicLabel, /padding-left:\s*2\.25rem;/);
  assert.match(musicLabel, /text-indent:\s*-1\.4rem;/);
  assert.doesNotMatch(musicLabel, /font-size:\s*0;/);
  assert.ok(musicLabelPrefix, "missing MUS replacement prefix");
  assert.match(musicLabelPrefix, /content:\s*"MUS";/);
  assert.match(musicLabelPrefix, /position:\s*absolute;/);
  assert.match(musicLabelPrefix, /width:\s*1\.9rem;/);
  assert.ok(musicStatus, "missing music status layout");
  assert.match(musicStatus, /grid-row:\s*2;/);

  assert.ok(cueIcons, "missing runtime cue icon mask");
  assert.match(cueIcons, /font-size:\s*0;/);
  assert.ok(cueIconsMark, "missing cue icon replacement mark");
  assert.match(cueIconsMark, /content:\s*"❖";/);
  assert.match(cueIconsMark, /font-size:\s*[^0][^;]*;/);
});

test("keeps inverted playing music controls intact while hovered", async () => {
  const css = await readFile(stylePath, "utf8");
  const playingHover = css.match(
    /\.music-button\.is-playing:hover:not\(:disabled\)\s*\{([^}]*)\}/s
  )?.[1];
  const playingHoverPrefix = css.match(
    /\.music-button\.is-playing:hover:not\(:disabled\) \.music-button__label::before\s*\{([^}]*)\}/s
  )?.[1];
  const playingHoverStatus = css.match(
    /\.music-button\.is-playing:hover:not\(:disabled\) \.music-button__status\s*\{([^}]*)\}/s
  )?.[1];

  assert.ok(playingHover, "missing playing-hover state");
  assert.match(playingHover, /background:\s*var\(--invert-bg\);/);
  assert.match(playingHover, /color:\s*var\(--invert-text\);/);
  assert.ok(playingHoverPrefix, "missing playing-hover MUS prefix state");
  assert.match(playingHoverPrefix, /background:\s*var\(--invert-bg\);/);
  assert.match(playingHoverPrefix, /color:\s*var\(--invert-text\);/);
  assert.ok(playingHoverStatus, "missing playing-hover status state");
  assert.match(playingHoverStatus, /color:\s*var\(--invert-text\);/);
});

test("keeps the current cue row inverted while hovered", async () => {
  const css = await readFile(stylePath, "utf8");
  const currentHover = css.match(
    /\.cue-row\.is-current:hover:not\(:disabled\),\s*\.cue-row\[aria-current="step"\]:hover:not\(:disabled\)\s*\{([^}]*)\}/s
  )?.[1];

  assert.ok(currentHover, "missing current-cue hover override");
  assert.match(currentHover, /border-color:\s*var\(--invert-bg\);/);
  assert.match(currentHover, /background:\s*var\(--invert-bg\);/);
  assert.match(currentHover, /color:\s*var\(--invert-text\);/);
});

test("uses the same high-contrast keyboard focus throughout the console", async () => {
  const css = await readFile(stylePath, "utf8");
  const focus = css.match(
    /button:focus-visible,\s*summary:focus-visible\s*\{([^}]*)\}/s
  )?.[1];
  const cuedFocus = css.match(
    /\.music-button\.is-cued:focus-visible\s*\{([^}]*)\}/s
  )?.[1];

  assert.ok(focus, "missing global keyboard focus rule");
  assert.match(focus, /outline:\s*3px solid #FFFFFF;/);
  assert.match(focus, /outline-offset:\s*3px;/);
  assert.ok(cuedFocus, "missing cued-music focus override");
  assert.match(cuedFocus, /animation:\s*none;/);
  assert.match(cuedFocus, /outline:\s*3px solid #FFFFFF;/);
  assert.match(cuedFocus, /outline-offset:\s*3px;/);
});

test("keeps NOW subtitles readable and visually ahead of UP NEXT", async () => {
  const css = await readFile(stylePath, "utf8");
  const nowPanel = css.match(/\.cue-panel--now\s*\{([^}]*)\}/s)?.[1];
  const nowHeading = css.match(
    /\.cue-panel--now \.cue-panel__header h1\s*\{([^}]*)\}/s
  )?.[1];
  const deckPanel = css.match(/\.cue-panel--deck\s*\{([^}]*)\}/s)?.[1];
  const nowKr = css.match(
    /(?:^|\n)\.cue-copy__kr\s*\{([^}]*)\}/s
  )?.[1];
  const deckKr = css.match(
    /\.cue-panel--deck \.cue-copy__kr\s*\{([^}]*)\}/s
  )?.[1];
  const english = css.match(
    /(?:^|\n)\.cue-copy__en\s*\{([^}]*)\}/s
  )?.[1];
  const mandarin = css.match(
    /(?:^|\n)\.cue-copy__zh\s*\{([^}]*)\}/s
  )?.[1];
  const copyLabel = css.match(/\.cue-copy__label\s*\{([^}]*)\}/s)?.[1];
  const currentNumber = css.match(
    /\.cue-row\.is-current \.cue-row__cn,\s*\.cue-row\[aria-current="step"\] \.cue-row__cn\s*\{([^}]*)\}/s
  )?.[1];
  const hoverNumber = css.match(
    /\.cue-row:hover:not\(:disabled\) \.cue-row__cn\s*\{([^}]*)\}/s
  )?.[1];

  assert.ok(nowPanel, "missing NOW panel rule");
  assert.match(nowPanel, /border-top:\s*6px solid var\(--text\);/);
  assert.ok(nowHeading, "missing NOW heading emphasis");
  assert.match(nowHeading, /color:\s*var\(--text\);/);
  assert.ok(deckPanel, "missing UP NEXT panel rule");
  assert.match(deckPanel, /border:\s*1px solid var\(--line\);/);
  assert.match(deckPanel, /background:\s*var\(--panel\);/);
  assert.ok(nowKr, "missing NOW Korean copy rule");
  assert.match(nowKr, /font-size:\s*clamp\(1\.35rem,[^;]+\);/);
  assert.match(nowKr, /line-height:\s*1\.6;/);
  assert.ok(deckKr, "missing UP NEXT Korean copy rule");
  assert.match(deckKr, /font-size:\s*clamp\(1rem,[^;]+1\.2rem\);/);
  assert.ok(english, "missing English copy rule");
  assert.match(english, /color:\s*var\(--text-dim\);/);
  assert.ok(mandarin, "missing Mandarin copy rule");
  assert.match(mandarin, /color:\s*var\(--text-dim\);/);
  assert.ok(copyLabel, "missing cue copy label rule");
  assert.match(copyLabel, /color:\s*var\(--text-dim\);/);
  assert.ok(currentNumber, "missing current cue number contrast override");
  assert.match(currentNumber, /color:\s*var\(--invert-text\);/);
  assert.ok(hoverNumber, "missing hovered cue number contrast override");
  assert.match(hoverNumber, /color:\s*var\(--text\);/);
});

test("uses readable lesson headers and keeps section numbers on one line", async () => {
  const css = await readFile(stylePath, "utf8");
  const sceneName = css.match(
    /\.scene-group__name\s*\{([^}]*)\}/s
  )?.[1];
  const sceneRange = css.match(
    /\.scene-group__range\s*\{([^}]*)\}/s
  )?.[1];
  const headingLead = css.match(
    /\.section-heading > div\s*\{([^}]*)\}/s
  )?.[1];
  const heading = css.match(/\.section-heading h2\s*\{([^}]*)\}/s)?.[1];

  assert.ok(sceneName, "missing scene lesson title rule");
  assert.match(sceneName, /color:\s*var\(--text\);/);
  assert.match(sceneName, /font-weight:\s*8\d\d;/);
  assert.doesNotMatch(sceneName, /text-transform:\s*lowercase;/);
  assert.ok(sceneRange, "missing scene supporting range rule");
  assert.match(sceneRange, /margin-left:\s*auto;/);
  assert.match(sceneRange, /color:\s*var\(--text-dim\);/);
  assert.match(sceneRange, /font-size:\s*0\.68rem;/);
  assert.doesNotMatch(sceneRange, /order:\s*-1;/);
  assert.ok(headingLead, "missing non-shrinking section heading lead");
  assert.match(headingLead, /flex:\s*0 0 auto;/);
  assert.ok(heading, "missing section heading rule");
  assert.match(heading, /white-space:\s*nowrap;/);
});

test("lays out the desktop console with a sticky cue-sheet scroller", async () => {
  const css = await readFile(stylePath, "utf8");
  const desktopEnd = css.indexOf("@media (max-width: 1099.98px)");
  const desktop = css.slice(0, desktopEnd);
  const body = desktop.match(/body\s*\{([^}]*)\}/s)?.[1];
  const consoleMain = desktop.match(/\.console-main\s*\{([^}]*)\}/s)?.[1];
  const operator = desktop.match(/\.operator-bar\s*\{([^}]*)\}/s)?.[1];
  const cueSheet = desktop.match(/#cue-sheet\s*\{([^}]*)\}/s)?.[1];
  const sequenceSteps = desktop.match(
    /\.sequence-steps\s*\{([^}]*)\}/s
  )?.[1];

  assert.notEqual(
    desktopEnd,
    -1,
    "missing fractional-safe 1099.98px stack breakpoint"
  );
  assert.ok(body, "missing desktop body rule");
  assert.match(body, /min-height:\s*100dvh;/);
  assert.match(body, /height:\s*100dvh;/);
  assert.match(body, /overflow:\s*hidden;/);
  assert.ok(consoleMain, "missing desktop console grid");
  assert.match(consoleMain, /display:\s*grid;/);
  assert.match(consoleMain, /height:\s*100dvh;/);
  assert.match(
    consoleMain,
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+clamp\(380px,\s*30vw,\s*420px\);/
  );
  assert.match(
    consoleMain,
    /grid-template-areas:\s*"operator cue-sheet"\s*"cues cue-sheet"\s*"unassigned cue-sheet"\s*"devices cue-sheet";/
  );
  assert.match(consoleMain, /overflow-y:\s*auto;/);
  assert.ok(operator, "missing compact desktop operator rule");
  assert.match(operator, /grid-area:\s*operator;/);
  assert.match(
    operator,
    /grid-template-columns:\s*minmax\(0,\s*[\d.]+fr\)\s+minmax\(1[45]rem,\s*[\d.]+fr\);/
  );
  assert.match(
    operator,
    /grid-template-areas:\s*"topline topline"\s*"transport music";/
  );
  assert.match(
    desktop,
    /\.cue-grid\s*\{[^}]*grid-area:\s*cues;[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s
  );
  assert.match(
    desktop,
    /#unassigned-banner\s*\{[^}]*grid-area:\s*unassigned;/s
  );
  assert.match(
    desktop,
    /\.devices-panel\s*\{[^}]*grid-area:\s*devices;/s
  );
  assert.ok(cueSheet, "missing desktop cue-sheet rule");
  assert.match(cueSheet, /grid-area:\s*cue-sheet;/);
  assert.match(cueSheet, /position:\s*sticky;/);
  assert.match(cueSheet, /top:\s*1rem;/);
  assert.match(cueSheet, /height:\s*calc\(100dvh - 2rem\);/);
  assert.match(cueSheet, /max-height:\s*calc\(100dvh - 2rem\);/);
  assert.match(cueSheet, /overflow-y:\s*auto;/);
  assert.match(cueSheet, /margin-top:\s*0;/);
  assert.ok(sequenceSteps, "missing desktop sequence list rule");
  assert.match(sequenceSteps, /max-height:\s*none;/);
  assert.match(sequenceSteps, /overflow:\s*visible;/);
  assert.match(
    desktop,
    /\.transport-secondary button\s*\{[^}]*min-height:\s*44px;[^}]*padding:[^;]+;/s
  );
  assert.match(
    desktop,
    /\.next-cue\s*\{[^}]*min-height:\s*48px;/s
  );
  assert.match(
    desktop,
    /\.cue-panel--deck \.cue-copy__en\s*\{[^}]*font-size:\s*[^;]+;/s
  );
  assert.match(
    desktop,
    /\.cue-panel--deck \.cue-details > div\s*\{[^}]*padding:\s*[^;]+;/s
  );
  assert.match(
    desktop,
    /\.role-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s
  );
  assert.match(
    desktop,
    /\.preview-stage img\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*object-fit:\s*contain;/s
  );
  assert.match(
    desktop,
    /\.health-details:not\(\[hidden\]\)\s*\{[^}]*position:\s*absolute;/s
  );
});

test("restores source-order scrolling below 1100px and one-column mobile cards", async () => {
  const css = await readFile(stylePath, "utf8");
  const stackStart = css.indexOf("@media (max-width: 1099.98px)");
  const mobileStart = css.indexOf("@media (max-width: 760px)");
  const narrowStart = css.indexOf("@media (max-width: 460px)");
  const reducedMotionStart = css.indexOf(
    "@media (prefers-reduced-motion: reduce)"
  );
  const stack = css.slice(stackStart, mobileStart);
  const mobile = css.slice(mobileStart, narrowStart);
  const narrow = css.slice(narrowStart, reducedMotionStart);

  assert.notEqual(
    stackStart,
    -1,
    "missing fractional-safe 1099.98px stack breakpoint"
  );
  assert.ok(mobileStart > stackStart, "760px rules must follow stack rules");
  assert.match(
    stack,
    /body\s*\{[^}]*height:\s*auto;[^}]*overflow-y:\s*auto;/s
  );
  assert.match(
    stack,
    /\.console-main\s*\{[^}]*display:\s*block;[^}]*height:\s*auto;[^}]*overflow:\s*visible;/s
  );
  assert.match(
    stack,
    /\.operator-bar\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:\s*20;/s
  );
  assert.match(
    stack,
    /#cue-sheet\s*\{[^}]*position:\s*static;[^}]*height:\s*auto;[^}]*max-height:\s*none;[^}]*overflow:\s*visible;[^}]*margin-top:\s*0\.85rem;/s
  );
  assert.match(
    stack,
    /\.sequence-steps\s*\{[^}]*max-height:\s*min\(52vh,\s*36rem\);[^}]*overflow-y:\s*auto;/s
  );
  assert.match(
    stack,
    /\.connection-pill\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1;/s
  );
  assert.match(
    stack,
    /\.transport-status\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*grid-row:\s*2;/s
  );
  assert.match(
    mobile,
    /\.cue-grid\s*\{[^}]*grid-template-columns:\s*1fr;/s
  );
  assert.match(
    mobile,
    /\.role-grid\s*\{[^}]*grid-template-columns:\s*1fr;/s
  );
  assert.match(
    narrow,
    /\.transport-topline\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/s
  );
  assert.match(
    narrow,
    /\.brand\s*\{[^}]*min-width:\s*0;[^}]*white-space:\s*normal;/s
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
