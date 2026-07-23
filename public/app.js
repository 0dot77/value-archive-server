const ROLES = ["A", "B"];
const PREVIEW_SOURCES = new Set(["eye", "pca"]);

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
  return Number.isFinite(value) && value >= 0 ? `${value.toFixed(2)} m` : "—";
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

function startDashboard() {
  const roleCards = Object.fromEntries(
    ROLES.map((role) => [
      role,
      document.querySelector(`[data-role-card="${role}"]`)
    ])
  );
  const connectionStatus = document.querySelector("#connection-status");
  const connectionPill = connectionStatus.closest(".connection-pill");
  const serverError = document.querySelector("#server-error");
  const unassignedList = document.querySelector("#unassigned-devices");
  const sequenceSteps = document.querySelector("#sequence-steps");
  const sequencePanel = document.querySelector("#sequence-panel");

  const state = {
    connection: "connecting",
    devices: [],
    roleOwners: { A: null, B: null },
    sequence: null,
    seqState: null,
    previewSources: { A: "pca", B: "pca" },
    previews: {
      A: { url: null, receivedAtMs: null },
      B: { url: null, receivedAtMs: null }
    }
  };

  let socket = null;
  let reconnectTimer = null;
  let unloading = false;
  let renderedUnassignedKey = null;
  let renderedSequence;

  function field(card, name) {
    return card.querySelector(`[data-field="${name}"]`);
  }

  function setText(element, value) {
    element.textContent = value;
  }

  function finiteMetric(value, suffix = "", digits = 1) {
    return Number.isFinite(value) && value >= 0
      ? `${value.toFixed(digits)}${suffix}`
      : "—";
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
      disconnected: "연결 끊김"
    };
    setText(connectionStatus, labels[nextConnection]);
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
      URL.revokeObjectURL(preview.url);
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
      URL.revokeObjectURL(preview.url);
    }
    preview.url = URL.createObjectURL(
      new Blob([jpegBytes], { type: "image/jpeg" })
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
    const online = state.connection === "connected" && device?.online === true;
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
    refresh.disabled = !online;
    for (const input of card.querySelectorAll(
      '[data-action="preview-source"]'
    )) {
      input.disabled = !online;
      input.checked = input.value === state.previewSources[role];
    }
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
    button.textContent = `→ ${role}`;
    button.disabled = state.connection !== "connected";
    container.append(button);
  }

  function renderUnassigned() {
    const renderKey = makeUnassignedRenderKey(
      state.devices,
      state.connection
    );
    if (renderKey === renderedUnassignedKey) {
      return;
    }
    renderedUnassignedKey = renderKey;
    unassignedList.replaceChildren();
    const unassigned = state.devices.filter((device) => device?.role == null);
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
        state.connection === "connected" && device.online === true;

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

  function sequenceStepsArray() {
    return Array.isArray(state.sequence?.steps) ? state.sequence.steps : [];
  }

  function renderSequenceSteps() {
    const steps = sequenceStepsArray();
    if (renderedSequence !== state.sequence) {
      renderedSequence = state.sequence;
      sequenceSteps.replaceChildren();
      if (steps.length === 0) {
        const item = document.createElement("li");
        item.className = "empty-state";
        item.textContent = "시퀀스 메타데이터 대기 중";
        sequenceSteps.append(item);
      } else {
        for (const [index, step] of steps.entries()) {
          const item = document.createElement("li");
          const button = document.createElement("button");

          button.type = "button";
          button.dataset.action = "goto-step";
          button.dataset.stepIndex = String(index);
          button.textContent = `${index}. ${String(step?.title ?? step?.stepId ?? "제목 없음")}`;
          item.append(button);
          sequenceSteps.append(item);
        }
      }
    }

    for (const button of sequenceSteps.querySelectorAll(
      '[data-action="goto-step"]'
    )) {
      const index = Number(button.dataset.stepIndex);
      const isCurrent = state.seqState?.stepIndex === index;
      button.disabled = state.connection !== "connected";
      if (isCurrent) {
        button.setAttribute("aria-current", "step");
      } else {
        button.removeAttribute("aria-current");
      }
    }
  }

  function renderSequence() {
    const seqState = state.seqState;
    const steps = sequenceStepsArray();
    const stepIndex = Number.isSafeInteger(seqState?.stepIndex)
      ? seqState.stepIndex
      : null;
    const step = stepIndex === null ? null : steps[stepIndex] ?? null;
    const running = seqState?.running === true;
    const status = sequencePanel.querySelector('[data-seq-field="status"]');

    setText(status, running ? "RUNNING" : "STOPPED");
    status.classList.toggle("is-running", running);
    status.classList.toggle("is-stopped", !running);
    setText(
      sequencePanel.querySelector('[data-seq-field="index"]'),
      stepIndex === null ? "—" : String(stepIndex)
    );
    setText(
      sequencePanel.querySelector('[data-seq-field="step-id"]'),
      seqState?.stepId ?? "—"
    );
    setText(
      sequencePanel.querySelector('[data-seq-field="title"]'),
      step?.title ?? "—"
    );

    const connected = state.connection === "connected";
    const controls = Object.fromEntries(
      [...sequencePanel.querySelectorAll("[data-seq-action]")].map(
        (button) => [button.dataset.seqAction, button]
      )
    );
    controls.start.disabled = !connected || running;
    controls.stop.disabled = !connected || !running;
    controls.prev.disabled = !connected || stepIndex === null || stepIndex <= 0;
    controls.next.disabled =
      !connected ||
      stepIndex === null ||
      stepIndex >= steps.length - 1;
    renderSequenceSteps();
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

  function sendJson(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }

  function handleJsonMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }
    switch (message.t) {
      case "ping":
        sendJson(makePongMessage(message.serverTimeMs));
        return;
      case "welcome":
        state.sequence = message.sequence ?? null;
        state.seqState = message.seqState ?? null;
        applyDevices(message.devices);
        renderSequence();
        return;
      case "deviceUpdate":
        applyDevices(message.devices);
        return;
      case "seqState":
        state.seqState = message;
        renderSequence();
        return;
      case "error":
        showError(message.code, message.message);
        return;
      default:
        return;
    }
  }

  function handleMessage(event) {
    if (typeof event.data === "string") {
      try {
        handleJsonMessage(JSON.parse(event.data));
      } catch {
        showError("INVALID_SERVER_MESSAGE", "서버 JSON을 해석할 수 없습니다.");
      }
      return;
    }

    const frame = parseFramePayload(event.data);
    if (frame) {
      replacePreview(frame.role, frame.jpegBytes);
    }
  }

  function scheduleReconnect() {
    if (unloading || reconnectTimer !== null) {
      return;
    }
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  }

  function connect() {
    if (
      socket &&
      (socket.readyState === WebSocket.CONNECTING ||
        socket.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    setConnection("connecting");
    let connection;
    try {
      connection = new WebSocket(makeWebSocketUrl(window.location));
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
      sendJson({ t: "hello", clientType: "dashboard" });
    });
    connection.addEventListener("message", handleMessage);
    connection.addEventListener("error", () => {
      showError("CONNECTION_ERROR", "WebSocket 연결에 문제가 발생했습니다.");
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

  function handleClick(event) {
    const button = event.target.closest?.("button");
    if (!button || button.disabled) {
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
      sendJson({
        t: "seqCommand",
        action: "goto",
        stepIndex: Number(button.dataset.stepIndex)
      });
      return;
    }
    if (button.dataset.seqAction) {
      sendJson({ t: "seqCommand", action: button.dataset.seqAction });
    }
  }

  function handleChange(event) {
    const input = event.target;
    if (input.dataset?.action !== "preview-source" || !input.checked) {
      return;
    }
    const role = input.dataset.role;
    const source = input.value;
    if (!ROLES.includes(role) || !PREVIEW_SOURCES.has(source)) {
      return;
    }
    state.previewSources[role] = source;
    sendJson({ t: "previewSource", role, source });
  }

  function teardown() {
    unloading = true;
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    window.clearInterval(ageTimer);
    for (const role of ROLES) {
      clearPreview(role);
    }
    socket?.close(1000, "Dashboard closing");
    socket = null;
  }

  document.addEventListener("click", handleClick);
  document.addEventListener("change", handleChange);
  const ageTimer = window.setInterval(renderRelativeAges, 1000);
  window.addEventListener("beforeunload", teardown, { once: true });

  renderRoleCards();
  renderUnassigned();
  renderSequence();
  connect();
}

if (
  typeof window !== "undefined" &&
  typeof document !== "undefined" &&
  typeof WebSocket !== "undefined"
) {
  startDashboard();
}
