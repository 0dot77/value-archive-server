import { spawn } from "node:child_process";
import dgram from "node:dgram";
import { createServer as createHttpServer } from "node:http";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import express from "express";
import { WebSocket, WebSocketServer } from "ws";

import { createRegistry } from "./registry.js";
import {
  createSequenceController,
  loadSequence
} from "./sequence.js";

const DISCOVERY_REQUEST = "VA_DISCOVER?";
const VALID_ROLES = new Set(["A", "B"]);
const VALID_PREVIEW_SOURCES = new Set(["eye", "pca"]);
const VALID_SUBTITLE_LANGS = new Set(["kr", "en", "zh"]);
const CLIENT_CONTEXT = Symbol("valueArchiveClientContext");
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function ipv4ToUnsignedInteger(address) {
  return address
    .split(".")
    .reduce((value, octet) => (value * 256 + Number(octet)) >>> 0, 0);
}

export function isIpv4InSubnet(
  requesterAddress,
  interfaceAddress,
  netmask
) {
  if (
    typeof requesterAddress !== "string" ||
    typeof interfaceAddress !== "string" ||
    typeof netmask !== "string" ||
    !isIPv4(requesterAddress) ||
    !isIPv4(interfaceAddress) ||
    !isIPv4(netmask)
  ) {
    return false;
  }

  const requester = ipv4ToUnsignedInteger(requesterAddress);
  const interfaceIp = ipv4ToUnsignedInteger(interfaceAddress);
  const mask = ipv4ToUnsignedInteger(netmask);
  return (
    ((requester & mask) >>> 0) === ((interfaceIp & mask) >>> 0)
  );
}

export function selectAdvertiseIp({
  configuredAdvertiseIp,
  requesterAddress,
  candidates
} = {}) {
  if (typeof configuredAdvertiseIp === "string") {
    return configuredAdvertiseIp;
  }

  const availableCandidates = Array.isArray(candidates) ? candidates : [];
  const matchingCandidate = availableCandidates.find((candidate) =>
    isIpv4InSubnet(
      requesterAddress,
      candidate?.address,
      candidate?.netmask
    )
  );
  if (matchingCandidate) {
    return matchingCandidate.address;
  }

  return typeof availableCandidates[0]?.address === "string"
    ? availableCandidates[0].address
    : "127.0.0.1";
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requirePort(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535) {
    throw new TypeError(`${name} must be an integer from 0 through 65535`);
  }
  return value;
}

function readVaPort() {
  const value = process.env.VA_PORT;
  if (value === undefined) {
    return undefined;
  }

  if (!/^[0-9]+$/.test(value)) {
    throw new TypeError(
      "VA_PORT must be a decimal integer from 1 through 65535"
    );
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(
      "VA_PORT must be a decimal integer from 1 through 65535"
    );
  }
  return port;
}

export function resolveHttpPort(options = {}) {
  if (!isObject(options)) {
    throw new TypeError("options must be an object");
  }
  return requirePort(
    options.httpPort ?? options.port ?? readVaPort() ?? 17800,
    "httpPort"
  );
}

function requirePositiveInterval(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return value;
}

function requireRole(role) {
  if (!VALID_ROLES.has(role)) {
    throw new TypeError('role must be either "A" or "B"');
  }
  return role;
}

function normalizeHealthMessage(message) {
  const normalizedMessage = clone(message);
  const telemetryNumbers = [
    normalizedMessage.fps,
    normalizedMessage.cvHz,
    normalizedMessage.cvMs
  ];
  if (
    telemetryNumbers.some(
      (value) =>
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0
    ) ||
    typeof normalizedMessage.batteryPct !== "number" ||
    !Number.isFinite(normalizedMessage.batteryPct) ||
    normalizedMessage.batteryPct > 100 ||
    !Array.isArray(normalizedMessage.markers) ||
    normalizedMessage.markers.some(
      (markerId) => !Number.isSafeInteger(markerId) || markerId < 0
    ) ||
    !isObject(normalizedMessage.dist) ||
    typeof normalizedMessage.trackingOk !== "boolean"
  ) {
    return null;
  }

  if (normalizedMessage.batteryPct < 0) {
    normalizedMessage.batteryPct = null;
  }

  for (const field of [
    "markerToMarker",
    "selfToOwn",
    "selfToOther"
  ]) {
    const distance = normalizedMessage.dist[field];
    if (
      distance !== null &&
      (typeof distance !== "number" ||
        !Number.isFinite(distance))
    ) {
      return null;
    }
    if (typeof distance === "number" && distance < 0) {
      normalizedMessage.dist[field] = null;
    }
  }

  const { t: _type, ...health } = normalizedMessage;
  return health;
}

function normalizeHttpAddress(address) {
  if (!address || typeof address === "string") {
    return null;
  }
  return {
    address: address.address,
    family: address.family,
    port: address.port
  };
}

function normalizeUdpAddress(address) {
  if (!address || typeof address === "string") {
    return null;
  }
  return {
    address: address.address,
    family: address.family,
    port: address.port
  };
}

function closeHttpServer(server) {
  if (!server) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections?.();
  });
}

function closeWebSocketServer(server) {
  if (!server) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeUdpSocket(socket) {
  if (!socket) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    try {
      socket.close(resolve);
    } catch (error) {
      if (error.code === "ERR_SOCKET_DGRAM_NOT_RUNNING") {
        resolve();
        return;
      }
      reject(error);
    }
  });
}

function listenHttp(server, port, host) {
  return new Promise((resolve, reject) => {
    function onError(error) {
      server.off("listening", onListening);
      reject(error);
    }

    function onListening() {
      server.off("error", onError);
      resolve();
    }

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function bindUdp(socket, port, host) {
  return new Promise((resolve, reject) => {
    function onError(error) {
      socket.off("listening", onListening);
      reject(error);
    }

    function onListening() {
      socket.off("error", onError);
      resolve();
    }

    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.bind(port, host);
  });
}

export function openDashboardInBrowser(
  url,
  {
    logger = console,
    platform = process.platform,
    spawn: spawnProcess = spawn
  } = {}
) {
  let failureReported = false;

  function reportFailure(detail) {
    if (failureReported) {
      return;
    }
    failureReported = true;

    try {
      const message =
        detail instanceof Error ? detail.message : String(detail);
      logger?.warn?.(`[VA] Could not open dashboard: ${message}`);
    } catch {
      // Browser launch failures must never interrupt server startup.
    }
  }

  try {
    let command;
    let args;

    if (platform === "win32") {
      command = "cmd";
      args = ["/c", "start", "", url];
    } else if (platform === "darwin") {
      command = "open";
      args = [url];
    } else {
      command = "xdg-open";
      args = [url];
    }

    const child = spawnProcess(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", reportFailure);
    child.once("exit", (code) => {
      if (code !== null && code !== 0) {
        reportFailure(`browser launcher exited with code ${code}`);
      }
    });
    child.unref();
  } catch (error) {
    reportFailure(error);
  }
}

export function createValueArchiveServer(options = {}) {
  if (!isObject(options)) {
    throw new TypeError("options must be an object");
  }

  const logger = options.logger ?? console;
  const registryFilePath =
    options.registryFilePath ??
    options.registryPath ??
    path.join(PROJECT_ROOT, "data", "devices.json");
  const sequenceFilePath =
    options.sequenceFilePath ??
    options.sequencePath ??
    path.join(PROJECT_ROOT, "data", "sequence.json");
  const publicDirectory =
    options.publicDirectory ?? path.join(PROJECT_ROOT, "public");
  const httpHost = requireNonEmptyString(
    options.httpHost ?? options.host ?? "0.0.0.0",
    "httpHost"
  );
  const httpPort = resolveHttpPort(options);
  const udpHost = requireNonEmptyString(
    options.udpHost ?? "0.0.0.0",
    "udpHost"
  );
  const udpPort = requirePort(options.udpPort ?? 47800, "udpPort");
  const pingIntervalMs = requirePositiveInterval(
    options.pingIntervalMs ?? 2000,
    "pingIntervalMs"
  );
  const deviceUpdateIntervalMs = requirePositiveInterval(
    options.deviceUpdateIntervalMs ?? options.updateIntervalMs ?? 1000,
    "deviceUpdateIntervalMs"
  );
  const offlineTimeoutMs = requirePositiveInterval(
    options.offlineTimeoutMs ?? options.healthTimeoutMs ?? 5000,
    "offlineTimeoutMs"
  );
  const now = options.now ?? Date.now;
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }

  requireNonEmptyString(registryFilePath, "registryFilePath");
  requireNonEmptyString(sequenceFilePath, "sequenceFilePath");
  requireNonEmptyString(publicDirectory, "publicDirectory");

  const configuredAdvertiseIp =
    options.advertiseIp ?? process.env.VA_ADVERTISE_IP;
  if (
    configuredAdvertiseIp !== undefined &&
    (!isIPv4(configuredAdvertiseIp) || configuredAdvertiseIp.trim() === "")
  ) {
    throw new TypeError("advertiseIp must be a valid IPv4 address");
  }

  const app = express();
  const devices = new Map();
  const previewSources = new Map([
    ["A", "pca"],
    ["B", "pca"]
  ]);

  let registry;
  let sequence;
  let sequenceController;
  let musicTracks;
  let subtitleState;
  let httpServer;
  let webSocketServer;
  let udpSocket;
  let pingInterval;
  let deviceUpdateInterval;
  let advertiseIp;
  let running = false;
  let startPromise;
  let stopPromise;
  let assignmentOperationChain = Promise.resolve();

  function emitLog(level, message) {
    const text = String(message);
    const prefixed = text.startsWith("[VA]") ? text : `[VA] ${text}`;
    const writer =
      (typeof logger?.[level] === "function" && logger[level]) ||
      (typeof logger?.log === "function" && logger.log);

    if (!writer) {
      return;
    }

    try {
      writer.call(logger, prefixed);
    } catch {
      // Logging must never break venue networking.
    }
  }

  function readNow() {
    const timestamp = now();
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
      throw new TypeError("now must return a finite number");
    }
    return timestamp;
  }

  function readAdvertiseCandidates(logInterfaces = false) {
    const candidates = [];

    for (const [interfaceName, addresses] of Object.entries(
      networkInterfaces()
    )) {
      for (const address of addresses ?? []) {
        const isIpv4Family =
          address.family === "IPv4" || address.family === 4;
        if (!isIpv4Family || address.internal) {
          continue;
        }

        candidates.push({
          address: address.address,
          netmask: address.netmask,
          cidr: address.cidr
        });
        if (logInterfaces) {
          emitLog("info", `IPv4 ${interfaceName}: ${address.address}`);
        }
      }
    }

    return candidates;
  }

  function selectStartupAdvertiseIp() {
    const candidates = readAdvertiseCandidates(true);

    if (candidates.length === 0) {
      emitLog("warn", "No non-internal IPv4 address found; using 127.0.0.1");
    }

    if (configuredAdvertiseIp) {
      emitLog("info", `Using advertised IPv4 override ${configuredAdvertiseIp}`);
    }

    return selectAdvertiseIp({ configuredAdvertiseIp, candidates });
  }

  function isOpen(socket) {
    return socket?.readyState === WebSocket.OPEN;
  }

  function safeSendJson(socket, message) {
    if (!isOpen(socket)) {
      return false;
    }

    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      emitLog("warn", `WebSocket send failed: ${error.message}`);
      return false;
    }
  }

  function socketIsCurrentQuest(socket) {
    const context = socket?.[CLIENT_CONTEXT];
    if (!context?.welcomed || context.clientType !== "quest") {
      return false;
    }

    return devices.get(context.deviceId)?.socket === socket;
  }

  function buildDeviceList(timestamp = readNow()) {
    return [...devices.values()]
      .map((device) => {
        const socketCurrent =
          device.socket &&
          devices.get(device.deviceId)?.socket === device.socket &&
          isOpen(device.socket);
        const freshestActivityMs = Math.max(
          device.connectedAtMs ?? Number.NEGATIVE_INFINITY,
          device.lastSeenMs ?? Number.NEGATIVE_INFINITY
        );
        const online =
          Boolean(socketCurrent) &&
          timestamp - freshestActivityMs <= offlineTimeoutMs;

        return {
          deviceId: device.deviceId,
          role: registry?.getRole(device.deviceId) ?? null,
          online,
          rttMs: device.rttMs ?? null,
          lastHealth:
            device.lastHealth === null ? null : clone(device.lastHealth),
          lastSeenMs: device.lastSeenMs ?? null
        };
      })
      .sort((left, right) =>
        left.deviceId < right.deviceId
          ? -1
          : left.deviceId > right.deviceId
            ? 1
            : 0
      );
  }

  function buildMusicState() {
    if (!musicTracks) {
      return null;
    }

    return {
      tracks: musicTracks.map((track) => ({
        trackId: track.trackId,
        label: track.label,
        file: track.file,
        playing: track.playing,
        startedAtServerMs: track.startedAtServerMs
      }))
    };
  }

  function buildSubtitleState() {
    if (!subtitleState) {
      return null;
    }

    return {
      lang: subtitleState.lang
    };
  }

  function getState() {
    return {
      devices: buildDeviceList(),
      seqState: sequenceController ? sequenceController.getState() : null,
      sequence: sequence ? clone(sequence) : null,
      musicState: buildMusicState(),
      subtitleState: buildSubtitleState()
    };
  }

  function forEachWelcomedClient(callback) {
    for (const socket of webSocketServer?.clients ?? []) {
      if (socket[CLIENT_CONTEXT]?.welcomed && isOpen(socket)) {
        callback(socket);
      }
    }
  }

  function forEachDashboard(callback) {
    forEachWelcomedClient((socket) => {
      if (socket[CLIENT_CONTEXT].clientType === "dashboard") {
        callback(socket);
      }
    });
  }

  function broadcastDeviceUpdate() {
    const message = { t: "deviceUpdate", devices: buildDeviceList() };
    forEachDashboard((socket) => safeSendJson(socket, message));
  }

  function broadcastSequenceState(seqState) {
    const message = { t: "seqState", ...seqState };
    forEachWelcomedClient((socket) => safeSendJson(socket, message));
  }

  function broadcastMusicState(musicState) {
    const message = { t: "musicState", ...musicState };
    forEachWelcomedClient((socket) => safeSendJson(socket, message));
  }

  function broadcastSubtitleState(nextSubtitleState) {
    const message = { t: "subtitleState", ...nextSubtitleState };
    forEachWelcomedClient((socket) => safeSendJson(socket, message));
  }

  function sendPings() {
    const message = { t: "ping", serverTimeMs: readNow() };
    forEachWelcomedClient((socket) => safeSendJson(socket, message));
  }

  function findQuestForRole(role) {
    const assignments = registry.getAssignments();
    const entry = Object.entries(assignments).find(
      ([, assignedRole]) => assignedRole === role
    );
    if (!entry) {
      return null;
    }

    const device = devices.get(entry[0]);
    if (
      !device ||
      !socketIsCurrentQuest(device.socket) ||
      !isOpen(device.socket)
    ) {
      return null;
    }
    return device.socket;
  }

  function assignDeviceRole(deviceId, role) {
    requireNonEmptyString(deviceId, "deviceId");
    requireRole(role);

    const operation = assignmentOperationChain.then(async () => {
      const previousAssignments = registry.getAssignments();
      const displacedDeviceId = Object.entries(previousAssignments).find(
        ([assignedDeviceId, assignedRole]) =>
          assignedRole === role && assignedDeviceId !== deviceId
      )?.[0];

      await registry.assignRole(deviceId, role);
      emitLog(
        "info",
        `Role assigned deviceId=${JSON.stringify(deviceId)} ` +
          `role=${JSON.stringify(role)}`
      );

      const assignedSocket = devices.get(deviceId)?.socket;
      if (socketIsCurrentQuest(assignedSocket)) {
        safeSendJson(assignedSocket, { t: "roleAssigned", role });
        safeSendJson(assignedSocket, {
          t: "previewSource",
          role,
          source: previewSources.get(role)
        });
      }

      if (displacedDeviceId) {
        const displacedSocket = devices.get(displacedDeviceId)?.socket;
        if (socketIsCurrentQuest(displacedSocket)) {
          safeSendJson(displacedSocket, { t: "roleAssigned", role: null });
        }
        emitLog(
          "warn",
          `Role ${role} reassigned from ` +
            `${JSON.stringify(displacedDeviceId)} to ${JSON.stringify(deviceId)}`
        );
      }

      broadcastDeviceUpdate();
      return buildDeviceList();
    });

    assignmentOperationChain = operation.catch(() => {});
    return operation;
  }

  function runMusicCommand(trackId, action) {
    if (action !== "play" && action !== "stop") {
      throw new TypeError('action must be either "play" or "stop"');
    }

    const track = musicTracks?.find(
      (candidate) => candidate.trackId === trackId
    );
    if (!track) {
      throw new TypeError("trackId must identify a known music track");
    }

    if (action === "play") {
      if (!track.playing) {
        const startedAtServerMs = readNow();
        track.playing = true;
        track.startedAtServerMs = startedAtServerMs;
      }
    } else {
      track.playing = false;
      track.startedAtServerMs = null;
    }

    emitLog(
      "info",
      `Music action=${JSON.stringify(action)} ` +
        `trackId=${JSON.stringify(trackId)}`
    );
    const musicState = buildMusicState();
    broadcastMusicState(musicState);
    return musicState;
  }

  function runStepMusicCue(musicCue) {
    if (!isObject(musicCue)) {
      return;
    }

    const action =
      musicCue.action === "in"
        ? "play"
        : musicCue.action === "out" || musicCue.action === "fadeDown"
          ? "stop"
          : null;
    if (!action) {
      emitLog(
        "warn",
        `Music cue ignored trackId=${JSON.stringify(musicCue.trackId)} ` +
          `action=${JSON.stringify(musicCue.action)}: unsupported action`
      );
      return;
    }

    const trackExists = musicTracks?.some(
      (track) => track.trackId === musicCue.trackId
    );
    if (!trackExists) {
      emitLog(
        "warn",
        `Music cue ignored trackId=${JSON.stringify(musicCue.trackId)} ` +
          `action=${JSON.stringify(musicCue.action)}: unknown track`
      );
      return;
    }

    runMusicCommand(musicCue.trackId, action);
  }

  function stopAllMusic() {
    for (const track of musicTracks ?? []) {
      if (track.playing) {
        runMusicCommand(track.trackId, "stop");
      }
    }
  }

  function runSequenceCommand(action, stepIndex) {
    const state = sequenceController.command(action, stepIndex);
    emitLog(
      "info",
      `Sequence action=${JSON.stringify(action)} running=${state.running} ` +
        `stepIndex=${state.stepIndex} stepId=${JSON.stringify(state.stepId)}`
    );

    if (action === "reset") {
      for (const track of musicTracks ?? []) {
        track.playing = false;
        track.startedAtServerMs = null;
      }
      subtitleState.lang = "kr";
      const musicState = buildMusicState();
      const nextSubtitleState = buildSubtitleState();
      broadcastSequenceState(state);
      broadcastMusicState(musicState);
      broadcastSubtitleState(nextSubtitleState);
      return state;
    }

    broadcastSequenceState(state);

    if (action === "stop") {
      stopAllMusic();
    } else {
      runStepMusicCue(state.params.musicCue);
    }

    return state;
  }

  function runSubtitleCommand(lang) {
    if (!VALID_SUBTITLE_LANGS.has(lang)) {
      throw new TypeError('lang must be one of "kr", "en", or "zh"');
    }

    subtitleState.lang = lang;
    emitLog("info", `Subtitle lang=${JSON.stringify(lang)}`);
    const nextSubtitleState = buildSubtitleState();
    broadcastSubtitleState(nextSubtitleState);
    return nextSubtitleState;
  }

  function sendSocketError(socket, code, message) {
    safeSendJson(socket, {
      t: "error",
      code,
      message: String(message)
    });
  }

  function handleQuestHello(socket, message) {
    let deviceId;
    try {
      deviceId = requireNonEmptyString(message.deviceId, "deviceId");
    } catch (error) {
      sendSocketError(socket, "INVALID_HELLO", error.message);
      return;
    }

    socket[CLIENT_CONTEXT] = {
      welcomed: true,
      clientType: "quest",
      deviceId
    };

    const timestamp = readNow();
    const existingDevice = devices.get(deviceId);
    const previousSocket = existingDevice?.socket;
    const device = existingDevice ?? {
      deviceId,
      socket: null,
      connectedAtMs: null,
      lastHealth: null,
      lastSeenMs: null,
      rttMs: null
    };
    device.socket = socket;
    device.connectedAtMs = timestamp;
    device.rttMs = null;
    devices.set(deviceId, device);

    if (previousSocket && previousSocket !== socket && isOpen(previousSocket)) {
      previousSocket.close(4001, "Replaced by a newer device connection");
    }

    const role = registry.getRole(deviceId);
    emitLog(
      "info",
      `Quest connected deviceId=${JSON.stringify(deviceId)} ` +
        `appVersion=${JSON.stringify(message.appVersion ?? null)} ` +
        `role=${JSON.stringify(role)}`
    );
    safeSendJson(socket, {
      t: "welcome",
      role,
      serverTimeMs: timestamp,
      seqState: sequenceController.getState(),
      musicState: buildMusicState(),
      subtitleState: buildSubtitleState()
    });
    if (role) {
      safeSendJson(socket, {
        t: "previewSource",
        role,
        source: previewSources.get(role)
      });
    }
    broadcastDeviceUpdate();
  }

  function handleDashboardHello(socket) {
    socket[CLIENT_CONTEXT] = {
      welcomed: true,
      clientType: "dashboard"
    };
    emitLog("info", "Dashboard connected");
    const state = getState();
    safeSendJson(socket, {
      t: "welcome",
      serverTimeMs: readNow(),
      devices: state.devices,
      seqState: state.seqState,
      sequence: state.sequence,
      musicState: state.musicState,
      subtitleState: state.subtitleState
    });
  }

  function handleHello(socket, message) {
    if (message.t !== "hello") {
      sendSocketError(
        socket,
        "HELLO_REQUIRED",
        "The first message must be a hello"
      );
      return;
    }

    if (message.clientType === "quest") {
      handleQuestHello(socket, message);
      return;
    }
    if (message.clientType === "dashboard") {
      handleDashboardHello(socket);
      return;
    }

    sendSocketError(
      socket,
      "INVALID_HELLO",
      'clientType must be either "quest" or "dashboard"'
    );
  }

  function handleQuestMessage(socket, message) {
    if (!socketIsCurrentQuest(socket)) {
      return;
    }

    const device = devices.get(socket[CLIENT_CONTEXT].deviceId);
    if (message.t === "voFinished") {
      if (
        typeof message.stepId !== "string" ||
        message.stepId.trim().length === 0
      ) {
        return;
      }

      const role = registry.getRole(socket[CLIENT_CONTEXT].deviceId);
      if (role === null) {
        return;
      }

      const status = {
        t: "voStatus",
        stepId: message.stepId,
        role,
        finishedAtServerMs: readNow()
      };
      forEachDashboard((dashboard) => safeSendJson(dashboard, status));
      return;
    }

    if (message.t === "health") {
      const health = normalizeHealthMessage(message);
      if (!health) {
        return;
      }
      device.lastHealth = health;
      device.lastSeenMs = readNow();
      broadcastDeviceUpdate();
      return;
    }

    if (
      message.t === "pong" &&
      typeof message.echoedServerTimeMs === "number" &&
      Number.isFinite(message.echoedServerTimeMs)
    ) {
      device.rttMs = readNow() - message.echoedServerTimeMs;
      broadcastDeviceUpdate();
    }
  }

  async function handleDashboardMessage(socket, message) {
    try {
      switch (message.t) {
        case "pong":
          for (const field of ["clientTimeMs", "echoedServerTimeMs"]) {
            if (
              typeof message[field] !== "number" ||
              !Number.isFinite(message[field])
            ) {
              throw new TypeError(`${field} must be a finite number`);
            }
          }
          return;

        case "assignRole":
          await assignDeviceRole(message.deviceId, message.role);
          return;

        case "seqCommand":
          runSequenceCommand(message.action, message.stepIndex);
          return;

        case "musicCommand":
          runMusicCommand(message.trackId, message.action);
          return;

        case "subtitleCommand":
          runSubtitleCommand(message.lang);
          return;

        case "requestFrame": {
          const role = requireRole(message.role);
          await assignmentOperationChain;
          const quest = findQuestForRole(role);
          if (!quest) {
            sendSocketError(
              socket,
              "TARGET_UNAVAILABLE",
              `No connected Quest is currently assigned role ${role}`
            );
            return;
          }
          safeSendJson(quest, { t: "requestFrame", role });
          return;
        }

        case "previewSource": {
          const role = requireRole(message.role);
          if (!VALID_PREVIEW_SOURCES.has(message.source)) {
            throw new TypeError('source must be either "eye" or "pca"');
          }
          await assignmentOperationChain;
          const quest = findQuestForRole(role);
          if (!quest) {
            sendSocketError(
              socket,
              "TARGET_UNAVAILABLE",
              `No connected Quest is currently assigned role ${role}`
            );
            return;
          }
          if (
            safeSendJson(quest, {
              t: "previewSource",
              role,
              source: message.source
            })
          ) {
            previewSources.set(role, message.source);
          } else {
            sendSocketError(
              socket,
              "TARGET_UNAVAILABLE",
              `Quest assigned role ${role} became unavailable`
            );
          }
          return;
        }

        default:
          sendSocketError(
            socket,
            "UNKNOWN_MESSAGE",
            `Unsupported dashboard message type: ${String(message.t)}`
          );
      }
    } catch (error) {
      const code =
        message.t === "assignRole"
          ? "INVALID_ASSIGNMENT"
          : message.t === "seqCommand"
            ? "INVALID_SEQUENCE_COMMAND"
            : message.t === "musicCommand"
              ? "INVALID_MUSIC_COMMAND"
              : message.t === "subtitleCommand"
                ? "INVALID_SUBTITLE_COMMAND"
                : "INVALID_CONTROL";
      sendSocketError(socket, code, error.message);
    }
  }

  async function handleTextMessage(socket, data) {
    let message;
    try {
      message = JSON.parse(Buffer.from(data).toString("utf8"));
    } catch {
      if (socket[CLIENT_CONTEXT]?.clientType === "dashboard") {
        sendSocketError(socket, "MALFORMED_JSON", "Message is not valid JSON");
      }
      return;
    }

    if (!isObject(message) || typeof message.t !== "string") {
      if (socket[CLIENT_CONTEXT]?.clientType === "dashboard") {
        sendSocketError(
          socket,
          "INVALID_MESSAGE",
          "JSON messages must be objects with a string t field"
        );
      }
      return;
    }

    const context = socket[CLIENT_CONTEXT];
    if (!context?.welcomed) {
      handleHello(socket, message);
      return;
    }
    if (context.clientType === "quest") {
      handleQuestMessage(socket, message);
      return;
    }
    await handleDashboardMessage(socket, message);
  }

  function handleBinaryMessage(socket, data) {
    if (!socketIsCurrentQuest(socket)) {
      return;
    }

    const bytes = Buffer.from(data);
    if (bytes.length < 2) {
      return;
    }

    const frameRole =
      bytes[0] === 0x41 ? "A" : bytes[0] === 0x42 ? "B" : null;
    const deviceId = socket[CLIENT_CONTEXT].deviceId;
    if (!frameRole || registry.getRole(deviceId) !== frameRole) {
      return;
    }

    forEachDashboard((dashboard) => {
      if (!isOpen(dashboard)) {
        return;
      }
      try {
        dashboard.send(bytes, { binary: true });
      } catch (error) {
        emitLog("warn", `Binary relay failed: ${error.message}`);
      }
    });
  }

  function acceptWebSocket(socket) {
    socket[CLIENT_CONTEXT] = {
      welcomed: false,
      clientType: null
    };

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        handleBinaryMessage(socket, data);
        return;
      }

      void handleTextMessage(socket, data).catch((error) => {
        emitLog("error", `WebSocket message failed: ${error.message}`);
        if (socket[CLIENT_CONTEXT]?.clientType === "dashboard") {
          sendSocketError(socket, "INTERNAL_ERROR", "Message handling failed");
        }
      });
    });

    socket.on("close", () => {
      const context = socket[CLIENT_CONTEXT];
      if (context?.clientType === "dashboard") {
        emitLog("info", "Dashboard disconnected");
        return;
      }
      if (context?.clientType !== "quest") {
        return;
      }

      emitLog(
        "info",
        `Quest disconnected deviceId=${JSON.stringify(context.deviceId)}`
      );
      const device = devices.get(context.deviceId);
      if (device?.socket !== socket) {
        return;
      }
      device.socket = null;
      device.connectedAtMs = null;
      broadcastDeviceUpdate();
    });

    socket.on("error", (error) => {
      emitLog("warn", `WebSocket client error: ${error.message}`);
    });
  }

  app.use(express.json({ limit: "64kb" }));

  app.get("/api/state", (_request, response) => {
    response.json(getState());
  });

  app.post("/api/assign", async (request, response) => {
    try {
      if (!isObject(request.body)) {
        throw new TypeError("request body must be a JSON object");
      }
      const devicesState = await assignDeviceRole(
        request.body.deviceId,
        request.body.role
      );
      response.json({ ok: true, devices: devicesState });
    } catch (error) {
      const isValidationError = error instanceof TypeError;
      response.status(isValidationError ? 400 : 500).json({
        ok: false,
        error: {
          code: isValidationError
            ? "INVALID_ASSIGNMENT"
            : "ASSIGNMENT_FAILED",
          message: error.message
        }
      });
    }
  });

  app.post("/api/seq", (request, response) => {
    try {
      if (!isObject(request.body)) {
        throw new TypeError("request body must be a JSON object");
      }
      const seqState = runSequenceCommand(
        request.body.action,
        request.body.stepIndex
      );
      response.json({ ok: true, seqState });
    } catch (error) {
      const isValidationError =
        error instanceof TypeError || error instanceof RangeError;
      response.status(isValidationError ? 400 : 500).json({
        ok: false,
        error: {
          code: isValidationError
            ? "INVALID_SEQUENCE_COMMAND"
            : "SEQUENCE_COMMAND_FAILED",
          message: error.message
        }
      });
    }
  });

  app.post("/api/music", (request, response) => {
    try {
      if (!isObject(request.body)) {
        throw new TypeError("request body must be a JSON object");
      }
      const musicState = runMusicCommand(
        request.body.trackId,
        request.body.action
      );
      response.json({ ok: true, musicState });
    } catch (error) {
      const isValidationError = error instanceof TypeError;
      response.status(isValidationError ? 400 : 500).json({
        ok: false,
        error: {
          code: isValidationError
            ? "INVALID_MUSIC_COMMAND"
            : "MUSIC_COMMAND_FAILED",
          message: error.message
        }
      });
    }
  });

  app.post("/api/subtitle", (request, response) => {
    try {
      if (!isObject(request.body)) {
        throw new TypeError("request body must be a JSON object");
      }
      const nextSubtitleState = runSubtitleCommand(request.body.lang);
      response.json({ ok: true, subtitleState: nextSubtitleState });
    } catch (error) {
      const isValidationError = error instanceof TypeError;
      response.status(isValidationError ? 400 : 500).json({
        ok: false,
        error: {
          code: isValidationError
            ? "INVALID_SUBTITLE_COMMAND"
            : "SUBTITLE_COMMAND_FAILED",
          message: error.message
        }
      });
    }
  });

  app.use(express.static(publicDirectory));

  app.use((error, _request, response, next) => {
    if (
      error instanceof SyntaxError &&
      error.status === 400 &&
      "body" in error
    ) {
      response.status(400).json({
        ok: false,
        error: {
          code: "MALFORMED_JSON",
          message: "Request body is not valid JSON"
        }
      });
      return;
    }
    next(error);
  });

  function address() {
    if (!running || !httpServer || !udpSocket) {
      return null;
    }

    return {
      http: normalizeHttpAddress(httpServer.address()),
      udp: normalizeUdpAddress(udpSocket.address()),
      advertiseIp
    };
  }

  async function start() {
    if (stopPromise) {
      await stopPromise;
    }
    if (running) {
      return address();
    }
    if (startPromise) {
      return startPromise;
    }

    startPromise = (async () => {
      registry = createRegistry({
        filePath: registryFilePath,
        logger: {
          error(message) {
            emitLog("error", message);
          }
        }
      });
      await registry.load();
      sequence = await loadSequence(sequenceFilePath);
      sequenceController = createSequenceController(sequence, { now });
      musicTracks = sequence.music.map((track) => ({
        trackId: track.trackId,
        label: track.label,
        file: track.file,
        playing: false,
        startedAtServerMs: null
      }));
      subtitleState = { lang: "kr" };
      devices.clear();
      advertiseIp = selectStartupAdvertiseIp();

      const nextHttpServer = createHttpServer(app);
      const nextWebSocketServer = new WebSocketServer({ noServer: true });
      const nextUdpSocket = dgram.createSocket("udp4");

      nextWebSocketServer.on("connection", acceptWebSocket);
      nextWebSocketServer.on("error", (error) => {
        emitLog("error", `WebSocket server error: ${error.message}`);
      });

      nextHttpServer.on("upgrade", (request, socket, head) => {
        let pathname;
        try {
          pathname = new URL(
            request.url,
            `http://${request.headers.host ?? "localhost"}`
          ).pathname;
        } catch {
          pathname = null;
        }

        if (pathname !== "/ws") {
          socket.end(
            "HTTP/1.1 404 Not Found\r\n" +
              "Connection: close\r\n" +
              "Content-Length: 0\r\n" +
              "\r\n"
          );
          return;
        }

        nextWebSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          nextWebSocketServer.emit(
            "connection",
            webSocket,
            request
          );
        });
      });

      try {
        await listenHttp(nextHttpServer, httpPort, httpHost);
        const boundHttpAddress = normalizeHttpAddress(nextHttpServer.address());
        emitLog(
          "info",
          `HTTP/WS listening on ${httpHost}:${boundHttpAddress.port}`
        );

        nextUdpSocket.on("message", (message, remote) => {
          if (message.toString("utf8") !== DISCOVERY_REQUEST) {
            return;
          }

          const actualHttpAddress = normalizeHttpAddress(
            nextHttpServer.address()
          );
          if (!actualHttpAddress) {
            return;
          }

          let replyAdvertiseIp = advertiseIp;
          if (configuredAdvertiseIp === undefined) {
            const candidates = readAdvertiseCandidates();
            const requesterMatched = candidates.some((candidate) =>
              isIpv4InSubnet(
                remote.address,
                candidate.address,
                candidate.netmask
              )
            );
            replyAdvertiseIp = selectAdvertiseIp({
              requesterAddress: remote.address,
              candidates
            });
            if (!requesterMatched) {
              emitLog(
                "warn",
                `No interface matched requester ${JSON.stringify(
                  remote.address
                )}; using fallback ${JSON.stringify(replyAdvertiseIp)}`
              );
            }
          }

          const response = Buffer.from(
            `VA_SERVER ${JSON.stringify({
              ip: replyAdvertiseIp,
              port: actualHttpAddress.port
            })}`
          );
          nextUdpSocket.send(
            response,
            remote.port,
            remote.address,
            (error) => {
              if (error) {
                emitLog(
                  "warn",
                  `UDP discovery response failed: ${error.message}`
                );
                return;
              }
              emitLog(
                "info",
                `UDP discovery reply remote=${JSON.stringify(
                  `${remote.address}:${remote.port}`
                )} advertised=${JSON.stringify(
                  `${replyAdvertiseIp}:${actualHttpAddress.port}`
                )}`
              );
            }
          );
        });
        await bindUdp(nextUdpSocket, udpPort, udpHost);
        const boundUdpAddress = normalizeUdpAddress(nextUdpSocket.address());
        emitLog(
          "info",
          `UDP discovery listening on ${udpHost}:${boundUdpAddress.port}`
        );
        nextUdpSocket.on("error", (error) => {
          emitLog("error", `UDP socket error: ${error.message}`);
        });
      } catch (error) {
        for (const client of nextWebSocketServer.clients) {
          client.terminate();
        }
        await Promise.allSettled([
          closeWebSocketServer(nextWebSocketServer),
          closeUdpSocket(nextUdpSocket),
          closeHttpServer(nextHttpServer)
        ]);
        throw error;
      }

      httpServer = nextHttpServer;
      webSocketServer = nextWebSocketServer;
      udpSocket = nextUdpSocket;
      running = true;

      pingInterval = setInterval(sendPings, pingIntervalMs);
      deviceUpdateInterval = setInterval(
        broadcastDeviceUpdate,
        deviceUpdateIntervalMs
      );
      pingInterval.unref?.();
      deviceUpdateInterval.unref?.();

      return address();
    })();

    try {
      return await startPromise;
    } finally {
      startPromise = undefined;
    }
  }

  async function stop() {
    if (stopPromise) {
      return stopPromise;
    }

    stopPromise = (async () => {
      const inFlightStart = startPromise;
      if (inFlightStart) {
        await inFlightStart.catch(() => {});
      }

      clearInterval(pingInterval);
      clearInterval(deviceUpdateInterval);
      pingInterval = undefined;
      deviceUpdateInterval = undefined;
      running = false;

      const closingWebSocketServer = webSocketServer;
      const closingUdpSocket = udpSocket;
      const closingHttpServer = httpServer;

      for (const socket of closingWebSocketServer?.clients ?? []) {
        socket.terminate();
      }
      for (const device of devices.values()) {
        device.socket = null;
        device.connectedAtMs = null;
      }

      const serviceClosures = [
        closeWebSocketServer(closingWebSocketServer),
        closeUdpSocket(closingUdpSocket),
        closeHttpServer(closingHttpServer)
      ];

      let observedAssignmentTail;
      do {
        observedAssignmentTail = assignmentOperationChain;
        await observedAssignmentTail;
      } while (observedAssignmentTail !== assignmentOperationChain);

      await Promise.all(serviceClosures);

      do {
        observedAssignmentTail = assignmentOperationChain;
        await observedAssignmentTail;
      } while (observedAssignmentTail !== assignmentOperationChain);

      webSocketServer = undefined;
      udpSocket = undefined;
      httpServer = undefined;
    })();

    try {
      await stopPromise;
    } finally {
      stopPromise = undefined;
    }
  }

  return {
    start,
    stop,
    address,
    getState
  };
}

function isCommandLineEntryPoint() {
  if (!process.argv[1]) {
    return false;
  }
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isCommandLineEntryPoint()) {
  const server = createValueArchiveServer();

  server.start().then((address) => {
    if (!shuttingDown && process.env.VA_NO_OPEN !== "1") {
      openDashboardInBrowser(
        `http://localhost:${address.http.port}`,
        { logger: console }
      );
    }
  }).catch((error) => {
    console.error(`[VA] Startup failed: ${error.message}`);
    process.exitCode = 1;
  });

  let shuttingDown = false;
  async function shutDown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.info(`[VA] ${signal} received; stopping`);
    try {
      await server.stop();
    } catch (error) {
      console.error(`[VA] Shutdown failed: ${error.message}`);
      process.exitCode = 1;
    }
  }

  process.once("SIGINT", () => void shutDown("SIGINT"));
  process.once("SIGTERM", () => void shutDown("SIGTERM"));
}
