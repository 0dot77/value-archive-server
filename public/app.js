const ROLES = ["A", "B"];
const SUBTITLE_LANGS = new Set(["kr", "en", "zh"]);
const SELECTABLE_SUBTITLE_LANGS = new Set(["en", "zh"]);
const DEFAULT_SUBTITLE_LANG = "zh";
// Measured verse-1 vocal onset of mus_추억속의재회.mp3.
const MUS_REUNION_VERSE_ONSET_SECONDS = 44.25;
const RESET_CONFIRM_MESSAGE = "공연을 시작 전 상태로 리셋할까요? 큐가 처음으로 돌아가고 음악이 모두 정지됩니다.";
const EDITABLE_TAG_NAMES = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const SPACE_INTERACTIVE_TAG_NAMES = new Set(["A", "BUTTON", "SUMMARY"]);

const DEMO_FALLBACK_SEQUENCE = {
  sequenceId: "value-archive-dashboard-demo",
  music: [
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
  ],
  steps: [
    {
      stepId: "demo-s1-001",
      title: "S1-1 오프닝 · 1",
      params: {
        cueNumber: 1,
        scene: "S1-1 오프닝",
        sceneId: "s1-1",
        speaker: "우경",
        textKr: "보세요. 지금 당신 앞에 오래된 명함집이 있습니다.",
        textEn: "Look. In front of you is an old business card holder.",
        textZh: "看。您面前有一个旧名片夹。",
        lines: [
          "보세요. 지금 당신 앞에",
          "오래된 명함집이 있습니다."
        ],
        xr: "(MR) 검은 방 in",
        ui: "",
        vo: "V.O_1.1.1",
        voDurationMs: 12_000,
        sfx: "sfx_paper",
        musicCue: null,
        note: "데모 샘플 첫 큐"
      }
    },
    {
      stepId: "demo-s1-002",
      title: "S1-1 오프닝 · 2",
      params: {
        cueNumber: 2,
        scene: "S1-1 오프닝",
        sceneId: "s1-1",
        speaker: "우경",
        textKr: "천천히 첫 장을 펼쳐 보세요.",
        textEn: "Slowly open the first page.",
        textZh: "请慢慢翻开第一页。",
        lines: ["천천히 첫 장을", "펼쳐 보세요."],
        xr: "",
        ui: "페이지 가이드 표시",
        vo: "V.O_1.1.2",
        voDurationMs: null,
        sfx: "",
        musicCue: {
          trackId: "father_1",
          action: "in",
          note: "천천히 시작"
        },
        note: ""
      }
    },
    {
      stepId: "demo-s2-003",
      title: "S2-1 명함 쥐기 · 3",
      params: {
        cueNumber: 3,
        scene: "S2-1 명함 쥐기",
        sceneId: "s2-1",
        speaker: "아빠",
        textKr: "당신이 쥔 명함의 감촉을 기억해 주세요.",
        textEn: "Remember the feel of the card in your hand.",
        textZh: "请记住手中名片的触感。",
        lines: [
          "당신이 쥔 명함의 감촉을",
          "기억해 주세요."
        ],
        xr: "(MR) 손 위에 명함 오버레이",
        ui: "손 위치 표시",
        vo: "V.O_2.1.1",
        voDurationMs: 9_000,
        sfx: "sfx_card_pickup",
        musicCue: {
          trackId: "father_2",
          action: "in",
          note: ""
        },
        note: "양쪽 Quest 확인"
      }
    },
    {
      stepId: "demo-s2-004",
      title: "S2-1 명함 쥐기 · 4",
      params: {
        cueNumber: 4,
        scene: "S2-1 명함 쥐기",
        sceneId: "s2-1",
        speaker: "아빠",
        textKr: "이제 서로를 향해 한 걸음 다가가세요.",
        textEn: "Now take one step toward each other.",
        textZh: "现在，请彼此靠近一步。",
        lines: ["이제 서로를 향해", "한 걸음 다가가세요."],
        xr: "상대 방향 포인터",
        ui: "",
        vo: "V.O_2.1.2",
        voDurationMs: null,
        sfx: "sfx_step",
        musicCue: {
          trackId: "father_1",
          action: "out",
          note: ""
        },
        note: "마지막 데모 큐"
      }
    }
  ]
};

export const RECONNECT_DELAY_MS = 2000;

export function makeWebSocketUrl(locationLike) {
  const scheme = locationLike.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${locationLike.host}/ws`;
}

export function makePongMessage(serverTimeMs, clientTimeMs = Date.now()) {
  return {
    t: "pong",
    clientTimeMs,
    echoedServerTimeMs: serverTimeMs
  };
}

export function makeUnassignedRenderKey(devices, connection) {
  const rows = (Array.isArray(devices) ? devices : [])
    .filter((device) => device?.role == null)
    .map((device) => [
      String(device?.deviceId ?? ""),
      device?.online === true
    ]);
  return JSON.stringify([connection, rows]);
}

export function formatDistance(value) {
  return Number.isFinite(value) && value >= 0
    ? `${(value * 100).toFixed(1)} cm`
    : "—";
}

export function formatAge(timestampMs, nowMs = Date.now()) {
  if (!Number.isFinite(timestampMs) || !Number.isFinite(nowMs)) {
    return "—";
  }
  const seconds = Math.floor(Math.max(0, nowMs - timestampMs) / 1000);
  return `${seconds}초 전`;
}

export function parseFramePayload(payload) {
  let bytes;
  if (payload instanceof ArrayBuffer) {
    bytes = new Uint8Array(payload);
  } else if (ArrayBuffer.isView(payload)) {
    bytes = new Uint8Array(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength
    );
  } else {
    return null;
  }

  if (bytes.byteLength < 2) {
    return null;
  }
  const role = bytes[0] === 0x41 ? "A" : bytes[0] === 0x42 ? "B" : null;
  return role ? { role, jpegBytes: bytes.slice(1) } : null;
}

export function reconcileRoleOwners(previousOwners, devices) {
  const owners = { A: null, B: null };
  for (const device of Array.isArray(devices) ? devices : []) {
    if (
      ROLES.includes(device?.role) &&
      typeof device.deviceId === "string" &&
      device.deviceId.length > 0
    ) {
      owners[device.role] = device.deviceId;
    }
  }

  const staleRoles = ROLES.filter(
    (role) =>
      previousOwners?.[role] &&
      previousOwners[role] !== owners[role]
  );
  return { owners, staleRoles };
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

export function normalizeCueParams(params) {
  const source =
    params && typeof params === "object" && !Array.isArray(params)
      ? params
      : {};
  const lines = Array.isArray(source.lines)
    ? source.lines.filter((line) => typeof line === "string")
    : typeof source.lines === "string"
      ? [source.lines]
      : [];
  const explicitTextKr = stringValue(source.textKr);
  const trackId =
    source.musicCue &&
    typeof source.musicCue === "object" &&
    !Array.isArray(source.musicCue)
      ? stringValue(source.musicCue.trackId).trim()
      : "";

  return {
    cueNumber: Number.isFinite(source.cueNumber)
      ? source.cueNumber
      : null,
    scene: stringValue(source.scene),
    sceneId: stringValue(source.sceneId),
    speaker: stringValue(source.speaker),
    textKr: explicitTextKr || lines.join("\n"),
    textEn: stringValue(source.textEn),
    textZh: stringValue(source.textZh),
    lines,
    xr: stringValue(source.xr),
    ui: stringValue(source.ui),
    vo: stringValue(source.vo),
    voDurationMs:
      Number.isFinite(source.voDurationMs) && source.voDurationMs >= 0
        ? source.voDurationMs
        : null,
    sfx: stringValue(source.sfx),
    musicCue: trackId
      ? {
          trackId,
          action: stringValue(source.musicCue.action),
          note: stringValue(source.musicCue.note)
        }
      : null,
    note: stringValue(source.note)
  };
}

export function calculateServerElapsedMs(
  enteredAtServerMs,
  clientNowMs = Date.now(),
  serverClockOffsetMs = 0
) {
  if (
    !Number.isFinite(enteredAtServerMs) ||
    !Number.isFinite(clientNowMs) ||
    !Number.isFinite(serverClockOffsetMs)
  ) {
    return null;
  }
  return Math.max(
    0,
    clientNowMs + serverClockOffsetMs - enteredAtServerMs
  );
}

export function groupStepsByScene(steps) {
  const groups = [];
  const groupsById = new Map();

  for (const [stepIndex, step] of (
    Array.isArray(steps) ? steps : []
  ).entries()) {
    const params = normalizeCueParams(step?.params);
    const sceneId = params.sceneId || "__ungrouped__";
    let group = groupsById.get(sceneId);
    if (!group) {
      group = {
        sceneId,
        scene: params.scene || "씬 미지정",
        startCueNumber: null,
        endCueNumber: null,
        entries: []
      };
      groupsById.set(sceneId, group);
      groups.push(group);
    }

    if (group.scene === "씬 미지정" && params.scene) {
      group.scene = params.scene;
    }
    if (Number.isFinite(params.cueNumber)) {
      if (group.startCueNumber === null) {
        group.startCueNumber = params.cueNumber;
      }
      group.endCueNumber = params.cueNumber;
    }
    group.entries.push({ stepIndex, step, params });
  }

  return groups;
}

export function needsJumpConfirmation(currentIndex, targetIndex) {
  return (
    Number.isSafeInteger(currentIndex) &&
    Number.isSafeInteger(targetIndex) &&
    Math.abs(targetIndex - currentIndex) >= 2
  );
}

export function makeMusicToggleMessage(track) {
  const trackId =
    track && typeof track === "object"
      ? stringValue(track.trackId).trim()
      : "";
  if (!trackId) {
    return null;
  }
  return {
    t: "musicCommand",
    trackId,
    action: track.playing === true ? "stop" : "play"
  };
}

export function makeSubtitleLangMessage(currentLang, pressedLang) {
  if (!SELECTABLE_SUBTITLE_LANGS.has(pressedLang)) {
    return null;
  }
  return {
    t: "subtitleCommand",
    lang: currentLang === pressedLang ? "kr" : pressedLang
  };
}

export function getSequenceShortcutAction(
  key,
  targetTagName = "",
  isContentEditable = false,
  isInteractiveTarget = false
) {
  const tagName = stringValue(targetTagName).toUpperCase();
  if (isContentEditable || EDITABLE_TAG_NAMES.has(tagName)) {
    return null;
  }
  if (
    key === " " &&
    (isInteractiveTarget || SPACE_INTERACTIVE_TAG_NAMES.has(tagName))
  ) {
    return null;
  }
  if (key === " " || key === "ArrowRight") {
    return "next";
  }
  return key === "ArrowLeft" ? "prev" : null;
}

export function scrollCueRowIntoView(
  currentRow,
  outerScrollers = [],
  viewport = null
) {
  if (!currentRow || typeof currentRow.scrollIntoView !== "function") {
    return false;
  }

  const savedScrollers = (
    Array.isArray(outerScrollers) ? outerScrollers : []
  )
    .filter(
      (scroller) =>
        scroller &&
        Number.isFinite(scroller.scrollLeft) &&
        Number.isFinite(scroller.scrollTop)
    )
    .map((scroller) => ({
      scroller,
      scrollLeft: scroller.scrollLeft,
      scrollTop: scroller.scrollTop
    }));
  const savedViewport =
    viewport &&
    Number.isFinite(viewport.scrollX) &&
    Number.isFinite(viewport.scrollY) &&
    typeof viewport.scrollTo === "function"
      ? { scrollX: viewport.scrollX, scrollY: viewport.scrollY }
      : null;

  currentRow.scrollIntoView({ block: "nearest" });

  for (const saved of savedScrollers) {
    saved.scroller.scrollLeft = saved.scrollLeft;
    saved.scroller.scrollTop = saved.scrollTop;
  }
  if (savedViewport) {
    viewport.scrollTo(savedViewport.scrollX, savedViewport.scrollY);
  }
  return true;
}

export function isDemoMode(search) {
  try {
    return new URLSearchParams(
      typeof search === "string" ? search : ""
    ).get("demo") === "1";
  } catch {
    return false;
  }
}

export async function loadDemoSequence(
  fetchImpl,
  fallbackSequence = DEMO_FALLBACK_SEQUENCE
) {
  if (typeof fetchImpl !== "function") {
    return fallbackSequence;
  }

  const sources = [
    {
      url: "./data/sequence.json",
      selectSequence: (documentValue) => documentValue
    },
    {
      url: "./api/state",
      selectSequence: (documentValue) => documentValue?.sequence
    }
  ];

  for (const source of sources) {
    try {
      const response = await fetchImpl(source.url);
      if (!response?.ok || typeof response.json !== "function") {
        continue;
      }
      const documentValue = await response.json();
      const sequence = source.selectSequence(documentValue);
      if (
        !sequence ||
        typeof sequence !== "object" ||
        !Array.isArray(sequence.steps) ||
        sequence.steps.length === 0
      ) {
        continue;
      }
      return {
        ...sequence,
        music:
          Array.isArray(sequence.music) && sequence.music.length > 0
            ? sequence.music
            : fallbackSequence.music
      };
    } catch {
      // Try the next read-only source before using the embedded sample.
    }
  }

  return fallbackSequence;
}

function startDashboard() {
  const roleCards = Object.fromEntries(
    ROLES.map((role) => [
      role,
      document.querySelector(`[data-role-card="${role}"]`)
    ])
  );
  const sequencePanel = document.querySelector("#sequence-panel");
  const connectionStatus = document.querySelector("#connection-status");
  const connectionPill = connectionStatus.closest(".connection-pill");
  const serverError = document.querySelector("#server-error");
  const unassignedBanner = document.querySelector("#unassigned-banner");
  const unassignedList = document.querySelector("#unassigned-devices");
  const sequenceSteps = document.querySelector("#sequence-steps");
  const musicChannels = document.querySelector("#music-channels");
  const verseCountdown = document.querySelector("[data-verse-countdown]");
  const cuePanels = {
    now: document.querySelector('[data-cue-panel="now"]'),
    deck: document.querySelector('[data-cue-panel="deck"]')
  };

  const state = {
    demo: isDemoMode(window.location.search),
    connection: "connecting",
    devices: [],
    roleOwners: { A: null, B: null },
    sequence: null,
    seqState: null,
    musicState: { tracks: [] },
    subtitleState: { lang: DEFAULT_SUBTITLE_LANG },
    serverClockOffsetMs: 0,
    voFinishedRoles: new Set(),
    previews: {
      A: { url: null, receivedAtMs: null },
      B: { url: null, receivedAtMs: null }
    }
  };

  let transport = null;
  let unloading = false;
  let renderedUnassignedKey = null;
  let renderedCueSheetSequence;
  let renderedCueSheetStepIndex = null;

  function field(card, name) {
    return card.querySelector(`[data-field="${name}"]`);
  }

  function setText(element, value) {
    element.textContent = value;
  }

  function displayValue(value) {
    return typeof value === "string" && value.trim().length > 0
      ? value
      : "—";
  }

  function finiteMetric(value, suffix = "", digits = 1) {
    return Number.isFinite(value) && value >= 0
      ? `${value.toFixed(digits)}${suffix}`
      : "—";
  }

  function formatClock(milliseconds, roundUp = false) {
    if (!Number.isFinite(milliseconds)) {
      return "—";
    }
    const seconds = (roundUp ? Math.ceil : Math.floor)(
      Math.max(0, milliseconds) / 1000
    );
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(
      remainder
    ).padStart(2, "0")}`;
  }

  function formatMusicAction(action) {
    const labels = {
      in: "IN",
      out: "OUT",
      fadeDown: "Fade Down"
    };
    return labels[action] ?? (action ? action : "CUE");
  }

  function sequenceStepsArray() {
    return Array.isArray(state.sequence?.steps)
      ? state.sequence.steps
      : [];
  }

  function currentStepIndex() {
    const index = state.seqState?.stepIndex;
    return Number.isSafeInteger(index) &&
      index >= 0 &&
      index < sequenceStepsArray().length
      ? index
      : null;
  }

  function stepAt(index, includeLiveParams = false) {
    const step = Number.isSafeInteger(index)
      ? sequenceStepsArray()[index] ?? null
      : null;
    if (
      !step ||
      !includeLiveParams ||
      index !== currentStepIndex() ||
      !state.seqState?.params ||
      typeof state.seqState.params !== "object"
    ) {
      return step;
    }
    return { ...step, params: state.seqState.params };
  }

  function currentStep() {
    const index = currentStepIndex();
    return index === null ? null : stepAt(index, true);
  }

  function currentParams() {
    return normalizeCueParams(currentStep()?.params);
  }

  function hasCueNumbers() {
    return sequenceStepsArray().some((step) =>
      Number.isFinite(normalizeCueParams(step?.params).cueNumber)
    );
  }

  function cueNumberLabel(step, index) {
    if (!step) {
      return "—";
    }
    const cueNumber = normalizeCueParams(step.params).cueNumber;
    if (Number.isFinite(cueNumber)) {
      return String(cueNumber);
    }
    return hasCueNumbers() ? "END" : String(index + 1);
  }

  function totalCueLabel() {
    const cueNumbers = sequenceStepsArray()
      .map((step) => normalizeCueParams(step?.params).cueNumber)
      .filter(Number.isFinite);
    return cueNumbers.length > 0
      ? String(Math.max(...cueNumbers))
      : sequenceStepsArray().length > 0
        ? String(sequenceStepsArray().length)
        : "—";
  }

  function subtitleLanguage() {
    return SUBTITLE_LANGS.has(state.subtitleState?.lang)
      ? state.subtitleState.lang
      : DEFAULT_SUBTITLE_LANG;
  }

  function canSequenceControl() {
    return (
      state.connection === "connected" || state.connection === "demo"
    );
  }

  function canServerControl() {
    return state.connection === "connected" && !state.demo;
  }

  function roleDevice(role) {
    return (
      state.devices.find((device) => device?.role === role) ?? null
    );
  }

  function setConnection(nextConnection) {
    state.connection = nextConnection;
    const labels = {
      connecting: "연결 중",
      connected: "연결됨",
      disconnected: "연결 끊김",
      demo: "데모 모드"
    };
    setText(
      connectionStatus,
      labels[nextConnection] ?? labels.disconnected
    );
    connectionPill.dataset.state = nextConnection;
    renderRoleCards();
    renderUnassigned();
    renderSequence();
  }

  function showError(code, message) {
    const safeCode =
      typeof code === "string" && code.length > 0 ? code : "ERROR";
    const safeMessage =
      typeof message === "string" && message.length > 0
        ? message
        : "알 수 없는 서버 오류";
    setText(serverError, `[${safeCode}] ${safeMessage}`);
    serverError.hidden = false;
  }

  function clearError() {
    setText(serverError, "");
    serverError.hidden = true;
  }

  function clearPreview(role) {
    const preview = state.previews[role];
    if (preview.url) {
      window.URL.revokeObjectURL(preview.url);
    }
    preview.url = null;
    preview.receivedAtMs = null;

    const card = roleCards[role];
    const image = card.querySelector("[data-preview-image]");
    image.removeAttribute("src");
    image.hidden = true;
    card.querySelector("[data-preview-placeholder]").hidden = false;
    setText(field(card, "frame-age"), "마지막 프레임 —");
  }

  function replacePreview(role, jpegBytes) {
    const preview = state.previews[role];
    if (preview.url) {
      window.URL.revokeObjectURL(preview.url);
    }
    preview.url = window.URL.createObjectURL(
      new window.Blob([jpegBytes], { type: "image/jpeg" })
    );
    preview.receivedAtMs = Date.now();

    const card = roleCards[role];
    const image = card.querySelector("[data-preview-image]");
    image.src = preview.url;
    image.hidden = false;
    card.querySelector("[data-preview-placeholder]").hidden = true;
    renderRelativeAges();
  }

  function renderRelativeAges() {
    const nowMs = Date.now();
    for (const role of ROLES) {
      const card = roleCards[role];
      const device = roleDevice(role);
      setText(
        field(card, "health-age"),
        formatAge(device?.lastSeenMs, nowMs)
      );
      const receivedAtMs = state.previews[role].receivedAtMs;
      setText(
        field(card, "frame-age"),
        receivedAtMs === null
          ? "마지막 프레임 —"
          : `마지막 프레임 ${formatAge(receivedAtMs, nowMs)}`
      );
    }
  }

  function renderRoleCard(role) {
    const card = roleCards[role];
    const device = roleDevice(role);
    const health = device?.lastHealth ?? null;
    const stateAvailable =
      state.connection === "connected" || state.connection === "demo";
    const online = stateAvailable && device?.online === true;
    const status = field(card, "status");

    setText(status, online ? "ONLINE" : "OFFLINE");
    status.classList.toggle("is-online", online);
    status.classList.toggle("is-offline", !online);
    setText(field(card, "device-id"), device?.deviceId ?? "미할당");
    setText(field(card, "rtt"), finiteMetric(device?.rttMs, " ms", 0));
    setText(field(card, "fps"), finiteMetric(health?.fps));
    setText(field(card, "cv-hz"), finiteMetric(health?.cvHz));
    setText(field(card, "cv-ms"), finiteMetric(health?.cvMs, " ms"));
    setText(field(card, "battery"), finiteMetric(health?.batteryPct, "%", 0));
    setText(
      field(card, "markers"),
      Array.isArray(health?.markers) && health.markers.length > 0
        ? health.markers.join(", ")
        : "—"
    );
    setText(
      field(card, "marker-to-marker"),
      formatDistance(health?.dist?.markerToMarker)
    );
    setText(
      field(card, "self-to-own"),
      formatDistance(health?.dist?.selfToOwn)
    );
    setText(
      field(card, "self-to-other"),
      formatDistance(health?.dist?.selfToOther)
    );

    const refresh = card.querySelector('[data-action="request-frame"]');
    refresh.disabled = !online || !canServerControl();
  }

  function renderRoleCards() {
    for (const role of ROLES) {
      renderRoleCard(role);
    }
    renderRelativeAges();
  }

  function appendAssignmentButton(container, deviceId, role) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "compact-button";
    button.dataset.action = "assign-role";
    button.dataset.deviceId = deviceId;
    button.dataset.role = role;
    button.setAttribute("data-server-control", "");
    button.textContent = `→ ${role}`;
    button.disabled = !canServerControl();
    container.append(button);
  }

  function renderUnassigned() {
    const unassigned = state.devices.filter((device) => device?.role == null);
    unassignedBanner.hidden = unassigned.length === 0;
    const renderKey = makeUnassignedRenderKey(
      state.devices,
      `${state.connection}:${canServerControl()}`
    );
    if (renderKey === renderedUnassignedKey) {
      return;
    }
    renderedUnassignedKey = renderKey;
    unassignedList.replaceChildren();
    if (unassigned.length === 0) {
      const item = document.createElement("li");
      item.className = "empty-state";
      item.textContent = "미지정 기기가 없습니다.";
      unassignedList.append(item);
      return;
    }

    for (const device of unassigned) {
      const item = document.createElement("li");
      const identity = document.createElement("div");
      const deviceId = document.createElement("strong");
      const status = document.createElement("span");
      const actions = document.createElement("div");
      const online =
        (state.connection === "connected" ||
          state.connection === "demo") &&
        device.online === true;

      identity.className = "device-identity";
      deviceId.textContent = String(device.deviceId ?? "알 수 없는 기기");
      status.className = online
        ? "mini-status is-online"
        : "mini-status is-offline";
      status.textContent = online ? "ONLINE" : "OFFLINE";
      actions.className = "assignment-actions";

      identity.append(deviceId, status);
      appendAssignmentButton(actions, String(device.deviceId ?? ""), "A");
      appendAssignmentButton(actions, String(device.deviceId ?? ""), "B");
      item.append(identity, actions);
      unassignedList.append(item);
    }
  }

  function normalizeMusicTracks() {
    const definitions = Array.isArray(state.sequence?.music)
      ? state.sequence.music
      : [];
    const liveTracks = Array.isArray(state.musicState)
      ? state.musicState
      : Array.isArray(state.musicState?.tracks)
        ? state.musicState.tracks
        : [];
    const tracksById = new Map();
    const orderedIds = [];

    function mergeTrack(rawTrack, isLive) {
      if (!rawTrack || typeof rawTrack !== "object") {
        return;
      }
      const trackId = stringValue(rawTrack.trackId).trim();
      if (!trackId) {
        return;
      }
      if (!tracksById.has(trackId)) {
        orderedIds.push(trackId);
        tracksById.set(trackId, {
          trackId,
          label: trackId,
          file: "",
          playing: false,
          startedAtServerMs: null
        });
      }
      const track = tracksById.get(trackId);
      const label = stringValue(rawTrack.label);
      const file = stringValue(rawTrack.file);
      if (label) {
        track.label = label;
      }
      if (file) {
        track.file = file;
      }
      if (isLive) {
        track.playing = rawTrack.playing === true;
        track.startedAtServerMs = Number.isFinite(
          rawTrack.startedAtServerMs
        )
          ? rawTrack.startedAtServerMs
          : null;
      }
    }

    for (const definition of definitions) {
      mergeTrack(definition, false);
    }
    for (const liveTrack of liveTracks) {
      mergeTrack(liveTrack, true);
    }
    return orderedIds.map((trackId) => tracksById.get(trackId));
  }

  function renderVerseCountdown() {
    const stepIndex = currentStepIndex();
    const lyricStepIndex = sequenceStepsArray().findIndex(
      (step) => step?.stepId === "s3-4-song"
    );
    const reunionTrack = normalizeMusicTracks().find(
      (track) => track.trackId === "mus_reunion"
    );
    const shouldShow =
      state.seqState?.running === true &&
      lyricStepIndex >= 0 &&
      stepIndex !== null &&
      stepIndex < lyricStepIndex;

    verseCountdown.hidden = !shouldShow;
    if (!shouldShow) {
      verseCountdown.classList.remove("is-idle", "is-arm", "is-go");
      return;
    }

    const isIdle = reunionTrack?.playing !== true;
    verseCountdown.classList.toggle("is-idle", isIdle);
    if (isIdle) {
      verseCountdown.classList.remove("is-arm", "is-go");
      verseCountdown.textContent = "가사 IN — 노래 대기 (CN 35)";
      return;
    }

    const elapsedMs = calculateServerElapsedMs(
      reunionTrack.startedAtServerMs,
      Date.now(),
      state.serverClockOffsetMs
    );
    if (elapsedMs === null) {
      verseCountdown.classList.remove("is-arm", "is-go");
      verseCountdown.textContent = "가사 IN —";
      return;
    }

    const remainingSeconds =
      MUS_REUNION_VERSE_ONSET_SECONDS - elapsedMs / 1000;
    const isGo = remainingSeconds <= 0;
    const isArm = !isGo && remainingSeconds <= 5;
    verseCountdown.classList.toggle("is-arm", isArm);
    verseCountdown.classList.toggle("is-go", isGo);

    if (isGo) {
      const lateSeconds = Math.abs(remainingSeconds).toFixed(1);
      verseCountdown.textContent = `GO — CN 38 · +${lateSeconds}s`;
      return;
    }
    verseCountdown.textContent = `가사 IN −${remainingSeconds.toFixed(1)}초`;
  }

  function renderMusicElapsed() {
    const tracksById = new Map(
      normalizeMusicTracks().map((track) => [track.trackId, track])
    );
    for (const element of musicChannels.querySelectorAll(
      "[data-music-elapsed]"
    )) {
      const track = tracksById.get(element.dataset.trackId);
      if (!track?.playing) {
        element.textContent = "○ 정지";
        continue;
      }
      const elapsedMs = calculateServerElapsedMs(
        track.startedAtServerMs,
        Date.now(),
        state.serverClockOffsetMs
      );
      element.textContent =
        elapsedMs === null
          ? "● 재생 중"
          : `● ${formatClock(elapsedMs)}`;
    }
  }

  function renderMusicChannels() {
    const tracks = normalizeMusicTracks();
    const activeMusicCue = currentParams().musicCue;
    musicChannels.replaceChildren();

    if (tracks.length === 0) {
      const empty = document.createElement("p");
      empty.className = "music-empty";
      empty.textContent = "음악 채널 없음";
      musicChannels.append(empty);
      return;
    }

    for (const track of tracks) {
      const button = document.createElement("button");
      const label = document.createElement("span");
      const status = document.createElement("span");
      const isCued = activeMusicCue?.trackId === track.trackId;

      button.type = "button";
      button.className = "music-button";
      button.dataset.action = "toggle-music";
      button.dataset.trackId = track.trackId;
      button.setAttribute("data-server-control", "");
      button.setAttribute("aria-pressed", String(track.playing));
      button.disabled = !canSequenceControl();
      button.classList.toggle("is-playing", track.playing);
      button.classList.toggle("is-cued", isCued);

      label.className = "music-button__label";
      label.textContent = `🎵 ${track.label}`;
      status.className = "music-button__status";
      status.dataset.musicElapsed = "";
      status.dataset.trackId = track.trackId;
      button.append(label, status);

      if (isCued) {
        const hint = document.createElement("span");
        const note = activeMusicCue.note
          ? ` · ${activeMusicCue.note}`
          : "";
        hint.className = "music-button__cue";
        hint.textContent = `현재 큐: ${formatMusicAction(
          activeMusicCue.action
        )}${note}`;
        button.append(hint);
      }
      musicChannels.append(button);
    }
    renderMusicElapsed();
  }

  function setCueField(panel, name, value) {
    const element = panel.querySelector(`[data-cue-field="${name}"]`);
    const rendered = displayValue(value);
    setText(element, rendered);
    const detailRow = element.closest(".cue-details > div");
    if (detailRow) {
      detailRow.hidden = rendered === "—";
    }
  }

  function musicCueText(musicCue) {
    if (!musicCue) {
      return "";
    }
    const track = normalizeMusicTracks().find(
      (candidate) => candidate.trackId === musicCue.trackId
    );
    const label = track?.label ?? musicCue.trackId;
    const note = musicCue.note ? ` · ${musicCue.note}` : "";
    return `${label} · ${formatMusicAction(musicCue.action)}${note}`;
  }

  function renderCuePanel(panel, step, stepIndex, kind) {
    const content = panel.querySelector("[data-cue-content]");
    const terminal = panel.querySelector("[data-cue-terminal]");
    if (!step) {
      content.hidden = true;
      terminal.hidden = false;
      terminal.textContent =
        kind === "deck" ? "마지막 큐" : "큐 데이터 대기 중";
      return;
    }

    const params = normalizeCueParams(step.params);
    content.hidden = false;
    terminal.hidden = true;
    setCueField(panel, "cn", cueNumberLabel(step, stepIndex));
    setCueField(panel, "scene", params.scene);
    setCueField(panel, "speaker", params.speaker);
    setCueField(panel, "text-kr", params.textKr);
    setCueField(panel, "text-en", params.textEn);
    setCueField(panel, "text-zh", params.textZh);
    const activeSubtitleLanguage = subtitleLanguage();
    for (const line of panel.querySelectorAll("[data-cue-lang]")) {
      const active = line.dataset.cueLang === activeSubtitleLanguage;
      line.classList.toggle("is-active", active);
      line.classList.toggle("is-inactive", !active);
    }
    setCueField(panel, "xr", params.xr);
    setCueField(panel, "ui", params.ui);
    setCueField(panel, "vo", params.vo);
    setCueField(panel, "sfx", params.sfx);
    setCueField(panel, "music", musicCueText(params.musicCue));
    setCueField(panel, "note", params.note);
  }

  function renderVoProgress() {
    const panel = cuePanels.now;
    const container = panel.querySelector("[data-vo-progress]");
    const params = currentParams();
    if (!currentStep() || !params.vo) {
      container.hidden = true;
      return;
    }

    container.hidden = false;
    const progress = container.querySelector("progress");
    const status = container.querySelector("[data-vo-status]");
    const time = container.querySelector("[data-vo-time]");
    const elapsedMs = calculateServerElapsedMs(
      state.seqState?.enteredAtServerMs,
      Date.now(),
      state.serverClockOffsetMs
    );

    if (Number.isFinite(params.voDurationMs)) {
      const durationMs = params.voDurationMs;
      const ratio =
        durationMs === 0
          ? 1
          : Math.min(1, (elapsedMs ?? 0) / durationMs);
      progress.hidden = false;
      progress.max = 1;
      progress.value = ratio;
      const complete = elapsedMs !== null && elapsedMs >= durationMs;
      status.textContent = complete ? "완료 예상" : "진행 중";
      time.textContent = complete
        ? "00:00"
        : `남은 ${formatClock(
            Math.max(0, durationMs - (elapsedMs ?? 0)),
            true
          )}`;
    } else {
      progress.hidden = true;
      status.textContent = "경과";
      time.textContent = formatClock(elapsedMs);
    }

    for (const role of ROLES) {
      const badge = container.querySelector(`[data-vo-role="${role}"]`);
      const finished = state.voFinishedRoles.has(role);
      badge.textContent = finished ? `${role} ✓` : `${role} —`;
      badge.classList.toggle("is-finished", finished);
    }
  }

  function cueRowIcons(params) {
    const icons = [];
    if (params.xr) {
      icons.push("🥽");
    }
    if (params.ui) {
      icons.push("🖥");
    }
    if (params.vo) {
      icons.push("🔊");
    }
    if (params.sfx) {
      icons.push("🔈");
    }
    if (params.musicCue) {
      icons.push("🎵");
    }
    return icons.length > 0 ? icons.join(" ") : "—";
  }

  function cueFirstLine(params) {
    const text = params.textKr || params.lines.join("\n");
    return text.split(/\r?\n/, 1)[0] || "—";
  }

  function sceneRangeLabel(group) {
    if (
      Number.isFinite(group.startCueNumber) &&
      Number.isFinite(group.endCueNumber)
    ) {
      return group.startCueNumber === group.endCueNumber
        ? `CN ${group.startCueNumber}`
        : `CN ${group.startCueNumber}–${group.endCueNumber}`;
    }
    const first = group.entries[0]?.stepIndex;
    const last = group.entries.at(-1)?.stepIndex;
    return Number.isSafeInteger(first) && Number.isSafeInteger(last)
      ? `${first + 1}–${last + 1}`
      : "—";
  }

  function rebuildCueSheet() {
    const groups = groupStepsByScene(sequenceStepsArray());
    sequenceSteps.replaceChildren();
    if (groups.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "시퀀스 메타데이터 대기 중";
      sequenceSteps.append(empty);
      return;
    }

    for (const group of groups) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      const sceneName = document.createElement("span");
      const range = document.createElement("span");
      const list = document.createElement("ol");

      details.className = "scene-group";
      details.dataset.sceneId = group.sceneId;
      sceneName.className = "scene-group__name";
      sceneName.textContent = group.scene;
      range.className = "scene-group__range";
      range.textContent = sceneRangeLabel(group);
      summary.append(sceneName, range);
      list.className = "scene-cues";

      for (const entry of group.entries) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        const cueNumber = document.createElement("span");
        const speaker = document.createElement("span");
        const subtitle = document.createElement("span");
        const icons = document.createElement("span");

        button.type = "button";
        button.className = "cue-row";
        button.dataset.action = "goto-step";
        button.dataset.stepIndex = String(entry.stepIndex);
        button.setAttribute("data-server-control", "");
        cueNumber.className = "cue-row__cn";
        cueNumber.textContent = `CN ${cueNumberLabel(
          entry.step,
          entry.stepIndex
        )}`;
        speaker.className = "cue-row__speaker";
        speaker.textContent = displayValue(entry.params.speaker);
        subtitle.className = "cue-row__subtitle";
        subtitle.textContent = cueFirstLine(entry.params);
        icons.className = "cue-row__icons";
        icons.textContent = cueRowIcons(entry.params);
        button.append(cueNumber, speaker, subtitle, icons);
        item.append(button);
        list.append(item);
      }

      details.append(summary, list);
      sequenceSteps.append(details);
    }
  }

  function renderCueSheet() {
    const stepIndex = currentStepIndex();
    const rebuilt = renderedCueSheetSequence !== state.sequence;
    if (rebuilt) {
      renderedCueSheetSequence = state.sequence;
      rebuildCueSheet();
    }

    const groups = groupStepsByScene(sequenceStepsArray());
    const currentGroup = groups.find((group) =>
      group.entries.some((entry) => entry.stepIndex === stepIndex)
    );
    for (const details of sequenceSteps.querySelectorAll(
      ".scene-group"
    )) {
      details.open =
        currentGroup != null &&
        details.dataset.sceneId === currentGroup.sceneId;
    }

    let currentRow = null;
    for (const button of sequenceSteps.querySelectorAll(
      '[data-action="goto-step"]'
    )) {
      const index = Number(button.dataset.stepIndex);
      const isCurrent = stepIndex === index;
      button.disabled = !canSequenceControl();
      button.classList.toggle("is-current", isCurrent);
      if (isCurrent) {
        button.setAttribute("aria-current", "step");
        currentRow = button;
      } else {
        button.removeAttribute("aria-current");
      }
    }

    if (
      currentRow &&
      (rebuilt || renderedCueSheetStepIndex !== stepIndex)
    ) {
      scrollCueRowIntoView(
        currentRow,
        [document.querySelector(".console-main")],
        window
      );
    }
    renderedCueSheetStepIndex = stepIndex;
  }

  function renderSequence() {
    const steps = sequenceStepsArray();
    const stepIndex = currentStepIndex();
    const step = stepIndex === null ? null : stepAt(stepIndex, true);
    const nextStep =
      stepIndex === null ? null : stepAt(stepIndex + 1, false);
    const running = state.seqState?.running === true;
    const status = sequencePanel.querySelector(
      '[data-seq-field="status"]'
    );

    setText(status, running ? "RUNNING" : "STOPPED");
    status.classList.toggle("is-running", running);
    status.classList.toggle("is-stopped", !running);
    setText(
      sequencePanel.querySelector('[data-seq-field="subtitle-lang"]'),
      `SUB ${subtitleLanguage().toUpperCase()}`
    );
    setText(
      sequencePanel.querySelector('[data-seq-field="cue-current"]'),
      stepIndex === null ? "—" : cueNumberLabel(step, stepIndex)
    );
    setText(
      sequencePanel.querySelector('[data-seq-field="cue-total"]'),
      totalCueLabel()
    );
    setText(
      sequencePanel.querySelector('[data-seq-field="scene"]'),
      displayValue(normalizeCueParams(step?.params).scene)
    );
    setText(
      sequencePanel.querySelector('[data-seq-field="index"]'),
      stepIndex === null ? "—" : String(stepIndex)
    );
    setText(
      sequencePanel.querySelector('[data-seq-field="step-id"]'),
      state.seqState?.stepId ?? step?.stepId ?? "—"
    );
    setText(
      sequencePanel.querySelector('[data-seq-field="title"]'),
      step?.title ?? "—"
    );

    const controls = Object.fromEntries(
      [...sequencePanel.querySelectorAll("[data-seq-action]")].map(
        (button) => [button.dataset.seqAction, button]
      )
    );
    const controllable = canSequenceControl();
    controls.start.disabled = !controllable || running || steps.length === 0;
    controls.stop.disabled = !controllable || !running;
    controls.reset.disabled = !controllable || steps.length === 0;
    controls.prev.disabled =
      !controllable || stepIndex === null || stepIndex <= 0;
    controls.next.disabled =
      !controllable ||
      stepIndex === null ||
      stepIndex >= steps.length - 1;
    const activeSubtitleLanguage = subtitleLanguage();
    for (const button of sequencePanel.querySelectorAll(
      '[data-action="set-subtitle-lang"][data-lang]'
    )) {
      button.disabled = !controllable;
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.lang === activeSubtitleLanguage)
      );
    }

    renderCuePanel(cuePanels.now, step, stepIndex ?? 0, "now");
    renderCuePanel(
      cuePanels.deck,
      nextStep,
      stepIndex === null ? 0 : stepIndex + 1,
      "deck"
    );
    renderMusicChannels();
    renderVerseCountdown();
    renderVoProgress();
    renderCueSheet();
  }

  function applyDevices(devices) {
    const nextDevices = Array.isArray(devices) ? devices : [];
    const reconciliation = reconcileRoleOwners(
      state.roleOwners,
      nextDevices
    );
    for (const role of reconciliation.staleRoles) {
      clearPreview(role);
    }
    state.devices = nextDevices;
    state.roleOwners = reconciliation.owners;
    renderRoleCards();
    renderUnassigned();
  }

  function setSequenceState(nextSeqState) {
    const previousStepId = state.seqState?.stepId ?? null;
    const previousStepIndex = state.seqState?.stepIndex ?? null;
    const nextStepId = nextSeqState?.stepId ?? null;
    const nextStepIndex = nextSeqState?.stepIndex ?? null;
    if (
      previousStepId !== nextStepId ||
      previousStepIndex !== nextStepIndex
    ) {
      state.voFinishedRoles.clear();
    }
    state.seqState =
      nextSeqState && typeof nextSeqState === "object"
        ? nextSeqState
        : null;
  }

  function updateClockOffset(serverTimeMs) {
    if (Number.isFinite(serverTimeMs)) {
      state.serverClockOffsetMs = serverTimeMs - Date.now();
    }
  }

  function sendJson(message) {
    return transport?.send(message) === true;
  }

  function handleJsonMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }
    switch (message.t) {
      case "ping":
        updateClockOffset(message.serverTimeMs);
        sendJson(makePongMessage(message.serverTimeMs));
        renderVoProgress();
        renderMusicElapsed();
        renderVerseCountdown();
        return;
      case "welcome":
        updateClockOffset(message.serverTimeMs);
        state.sequence =
          message.sequence && typeof message.sequence === "object"
            ? message.sequence
            : null;
        setSequenceState(message.seqState);
        state.musicState =
          message.musicState && typeof message.musicState === "object"
            ? message.musicState
            : { tracks: [] };
        state.subtitleState =
          message.subtitleState &&
          typeof message.subtitleState === "object"
            ? message.subtitleState
            : { lang: DEFAULT_SUBTITLE_LANG };
        applyDevices(message.devices);
        renderSequence();
        return;
      case "deviceUpdate":
        applyDevices(message.devices);
        return;
      case "seqState":
        setSequenceState(message);
        renderSequence();
        return;
      case "musicState":
        state.musicState = message;
        renderMusicChannels();
        renderVerseCountdown();
        return;
      case "subtitleState":
        state.subtitleState = message;
        renderSequence();
        return;
      case "voStatus":
        if (
          message.stepId === state.seqState?.stepId &&
          ROLES.includes(message.role)
        ) {
          state.voFinishedRoles.add(message.role);
          renderVoProgress();
        }
        return;
      case "error":
        showError(message.code, message.message);
        return;
      default:
        return;
    }
  }

  function handleIncomingData(data) {
    if (typeof data === "string") {
      try {
        handleJsonMessage(JSON.parse(data));
      } catch {
        showError(
          "INVALID_SERVER_MESSAGE",
          "서버 JSON을 해석할 수 없습니다."
        );
      }
      return;
    }

    const frame = parseFramePayload(data);
    if (frame) {
      replacePreview(frame.role, frame.jpegBytes);
    }
  }

  function createSocketAdapter() {
    let socket = null;
    let reconnectTimer = null;
    let disposed = false;

    function scheduleReconnect() {
      if (disposed || unloading || reconnectTimer !== null) {
        return;
      }
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, RECONNECT_DELAY_MS);
    }

    function connect() {
      const WebSocketConstructor = window.WebSocket;
      if (typeof WebSocketConstructor !== "function") {
        setConnection("disconnected");
        showError(
          "CONNECTION_ERROR",
          "이 브라우저는 WebSocket을 지원하지 않습니다."
        );
        scheduleReconnect();
        return;
      }
      if (
        socket &&
        (socket.readyState === WebSocketConstructor.CONNECTING ||
          socket.readyState === WebSocketConstructor.OPEN)
      ) {
        return;
      }

      setConnection("connecting");
      let connection;
      try {
        connection = new WebSocketConstructor(
          makeWebSocketUrl(window.location)
        );
      } catch (error) {
        setConnection("disconnected");
        showError("CONNECTION_ERROR", error.message);
        scheduleReconnect();
        return;
      }

      socket = connection;
      connection.binaryType = "arraybuffer";
      connection.addEventListener("open", () => {
        if (socket !== connection) {
          return;
        }
        clearError();
        setConnection("connected");
        send({ t: "hello", clientType: "dashboard" });
      });
      connection.addEventListener("message", (event) => {
        handleIncomingData(event.data);
      });
      connection.addEventListener("error", () => {
        showError(
          "CONNECTION_ERROR",
          "WebSocket 연결에 문제가 발생했습니다."
        );
      });
      connection.addEventListener("close", () => {
        if (socket !== connection) {
          return;
        }
        socket = null;
        setConnection("disconnected");
        scheduleReconnect();
      });
    }

    function send(message) {
      const WebSocketConstructor = window.WebSocket;
      if (
        !socket ||
        typeof WebSocketConstructor !== "function" ||
        socket.readyState !== WebSocketConstructor.OPEN
      ) {
        return false;
      }
      socket.send(JSON.stringify(message));
      return true;
    }

    function dispose() {
      disposed = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        try {
          socket.close(1000, "Dashboard closing");
        } catch {
          // The browser is already tearing the socket down.
        }
      }
      socket = null;
    }

    return { connect, send, dispose };
  }

  function createDemoAdapter() {
    let disposed = false;
    let demoSequence = null;
    let demoSeqState = null;
    let demoTracks = [];
    let demoSubtitleState = { lang: DEFAULT_SUBTITLE_LANG };

    function makeDemoDevices() {
      const nowMs = Date.now();
      return [
        {
          deviceId: "demo-quest-a",
          role: "A",
          online: true,
          rttMs: 18,
          lastSeenMs: nowMs,
          lastHealth: {
            fps: 72,
            cvHz: 30,
            cvMs: 8.4,
            batteryPct: 86,
            markers: [11, 12],
            dist: {
              markerToMarker: 0.42,
              selfToOwn: 0.31,
              selfToOther: 1.26
            }
          }
        },
        {
          deviceId: "demo-quest-b",
          role: "B",
          online: false,
          rttMs: null,
          lastSeenMs: null,
          lastHealth: null
        }
      ];
    }

    function makeSeqState(stepIndex, running, enteredAtServerMs) {
      const step = demoSequence.steps[stepIndex];
      return {
        sequenceId: demoSequence.sequenceId,
        running,
        stepIndex,
        stepId: step?.stepId ?? null,
        enteredAtServerMs,
        params: step?.params ?? {}
      };
    }

    async function connect() {
      setConnection("demo");
      const sequence = await loadDemoSequence(
        window.fetch?.bind(window)
      );
      if (disposed) {
        return;
      }
      demoSequence = sequence;
      demoSeqState = makeSeqState(0, false, Date.now());
      demoSubtitleState = { lang: DEFAULT_SUBTITLE_LANG };
      demoTracks = (Array.isArray(sequence.music)
        ? sequence.music
        : []
      ).map((track) => ({
        trackId: stringValue(track?.trackId),
        label: stringValue(track?.label),
        file: stringValue(track?.file),
        playing: false,
        startedAtServerMs: null
      }));
      handleJsonMessage({
        t: "welcome",
        serverTimeMs: Date.now(),
        devices: makeDemoDevices(),
        sequence: demoSequence,
        seqState: demoSeqState,
        musicState: { tracks: demoTracks },
        subtitleState: demoSubtitleState
      });
    }

    function applySequenceCommand(message) {
      if (!demoSequence || !demoSeqState) {
        return false;
      }
      const lastIndex = demoSequence.steps.length - 1;
      const previousIndex = demoSeqState.stepIndex;
      let nextIndex = previousIndex;
      let running = demoSeqState.running;

      switch (message.action) {
        case "start":
          running = true;
          nextIndex = 0;
          break;
        case "stop":
          running = false;
          break;
        case "reset":
          running = false;
          nextIndex = 0;
          break;
        case "next":
          nextIndex = Math.min(lastIndex, previousIndex + 1);
          break;
        case "prev":
          nextIndex = Math.max(0, previousIndex - 1);
          break;
        case "goto":
          if (
            !Number.isSafeInteger(message.stepIndex) ||
            message.stepIndex < 0 ||
            message.stepIndex > lastIndex
          ) {
            return false;
          }
          nextIndex = message.stepIndex;
          break;
        default:
          return false;
      }

      const enteredAtServerMs =
        nextIndex !== previousIndex ||
        message.action === "start" ||
        message.action === "reset"
          ? Date.now()
          : demoSeqState.enteredAtServerMs;
      demoSeqState = makeSeqState(
        nextIndex,
        running,
        enteredAtServerMs
      );
      handleJsonMessage({ t: "seqState", ...demoSeqState });

      if (message.action === "reset") {
        for (const track of demoTracks) {
          track.playing = false;
          track.startedAtServerMs = null;
        }
        demoSubtitleState = { lang: DEFAULT_SUBTITLE_LANG };
        handleJsonMessage({
          t: "musicState",
          tracks: demoTracks.map((track) => ({ ...track }))
        });
        handleJsonMessage({
          t: "subtitleState",
          ...demoSubtitleState
        });
      }

      return true;
    }

    function applyMusicCommand(message) {
      const track = demoTracks.find(
        (candidate) => candidate.trackId === message.trackId
      );
      if (
        !track ||
        (message.action !== "play" && message.action !== "stop")
      ) {
        return false;
      }
      track.playing = message.action === "play";
      track.startedAtServerMs = track.playing ? Date.now() : null;
      handleJsonMessage({
        t: "musicState",
        tracks: demoTracks.map((candidate) => ({ ...candidate }))
      });
      return true;
    }

    function applySubtitleCommand(message) {
      if (!SUBTITLE_LANGS.has(message.lang)) {
        return false;
      }
      demoSubtitleState = {
        lang: message.lang
      };
      handleJsonMessage({
        t: "subtitleState",
        ...demoSubtitleState
      });
      return true;
    }

    function send(message) {
      if (disposed || !message || typeof message !== "object") {
        return false;
      }
      if (message.t === "seqCommand") {
        return applySequenceCommand(message);
      }
      if (message.t === "musicCommand") {
        return applyMusicCommand(message);
      }
      if (message.t === "subtitleCommand") {
        return applySubtitleCommand(message);
      }
      return false;
    }

    function dispose() {
      disposed = true;
    }

    return { connect, send, dispose };
  }

  function renderLiveTimings() {
    renderRelativeAges();
    renderMusicElapsed();
    renderVerseCountdown();
    renderVoProgress();
  }

  function handleKeydown(event) {
    if (event.repeat) {
      return;
    }
    const interactiveTarget = event.target?.closest?.(
      'button, summary, a[href], [role="button"], [role="link"]'
    );
    const action = getSequenceShortcutAction(
      event.key,
      event.target?.tagName,
      event.target?.isContentEditable === true,
      Boolean(interactiveTarget)
    );
    if (!action) {
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
    }
    if (!canSequenceControl()) {
      return;
    }
    const button = sequencePanel.querySelector(
      `[data-seq-action="${action}"]`
    );
    if (!button || button.disabled) {
      return;
    }
    event.preventDefault();
    button.click();
  }

  function handleClick(event) {
    const button = event.target.closest?.("button");
    if (!button || button.disabled) {
      return;
    }

    if (button.dataset.action === "toggle-health") {
      const details = document.querySelector(
        `#${button.getAttribute("aria-controls")}`
      );
      const expanded = details.hidden;
      details.hidden = !expanded;
      button.setAttribute("aria-expanded", String(expanded));
      button.textContent = expanded ? "상세 ▴" : "상세 ▾";
      return;
    }
    if (button.dataset.action === "assign-role") {
      sendJson({
        t: "assignRole",
        deviceId: button.dataset.deviceId,
        role: button.dataset.role
      });
      return;
    }
    if (button.dataset.action === "request-frame") {
      sendJson({ t: "requestFrame", role: button.dataset.role });
      return;
    }
    if (button.dataset.action === "goto-step") {
      const targetIndex = Number(button.dataset.stepIndex);
      const currentIndex = currentStepIndex();
      if (
        needsJumpConfirmation(currentIndex, targetIndex) &&
        !window.confirm(
          `현재 위치에서 CN ${cueNumberLabel(
            stepAt(targetIndex),
            targetIndex
          )}(으)로 이동할까요?`
        )
      ) {
        return;
      }
      sendJson({
        t: "seqCommand",
        action: "goto",
        stepIndex: targetIndex
      });
      return;
    }
    if (button.dataset.action === "toggle-music") {
      const track = normalizeMusicTracks().find(
        (candidate) => candidate.trackId === button.dataset.trackId
      );
      const message = makeMusicToggleMessage(track);
      if (message) {
        sendJson(message);
      }
      return;
    }
    if (button.dataset.action === "set-subtitle-lang") {
      const message = makeSubtitleLangMessage(
        subtitleLanguage(),
        button.dataset.lang
      );
      if (message) {
        sendJson(message);
      }
      return;
    }
    if (button.dataset.seqAction === "reset") {
      if (!window.confirm(RESET_CONFIRM_MESSAGE)) {
        return;
      }
      sendJson({ t: "seqCommand", action: "reset" });
      return;
    }
    if (button.dataset.seqAction) {
      sendJson({ t: "seqCommand", action: button.dataset.seqAction });
    }
  }

  function teardown() {
    unloading = true;
    window.clearInterval(liveTimer);
    document.removeEventListener("click", handleClick);
    document.removeEventListener("keydown", handleKeydown);
    for (const role of ROLES) {
      clearPreview(role);
    }
    transport?.dispose();
    transport = null;
  }

  document.addEventListener("click", handleClick);
  document.addEventListener("keydown", handleKeydown);
  const liveTimer = window.setInterval(renderLiveTimings, 100);
  window.addEventListener("beforeunload", teardown, { once: true });

  renderRoleCards();
  renderUnassigned();
  renderSequence();
  transport = state.demo
    ? createDemoAdapter()
    : createSocketAdapter();
  transport.connect();
}

if (
  typeof window !== "undefined" &&
  typeof document !== "undefined"
) {
  startDashboard();
}
