import dgram from "node:dgram";
import { isIPv4 } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { WebSocket } from "ws";

const APP_VERSION = "value-archive-mock/1.0.0";
const DIRECT_PORT = 8080;
const DISCOVERY_ADDRESS = "255.255.255.255";
const DISCOVERY_PORT = 47800;
const DISCOVERY_REQUEST = "VA_DISCOVER?";
const DISCOVERY_RESPONSE_PREFIX = "VA_SERVER ";
const DISCOVERY_TIMEOUT_MS = 1_500;
const DISCOVERY_RETRY_MS = 500;
const HEALTH_INTERVAL_MS = 1_000;
const FRAME_INTERVAL_MS = 3_000;
const RECONNECT_INTERVAL_MS = 2_000;
const USAGE =
  "Usage: node tools/mock-quest.js <deviceId> [--direct 127.0.0.1]";

// 8x8 solid-color JPEGs, generated once and embedded so the mock has no
// image-library or runtime image-generation dependency.
const ROLE_A_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoH" +
  "BwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQME" +
  "BAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU" +
  "FBQUFBQUFBQUFBQUFBT/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEA" +
  "AAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIh" +
  "MUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6" +
  "Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZ" +
  "mqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx" +
  "8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA" +
  "AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAV" +
  "YnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hp" +
  "anN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPE" +
  "xcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDz" +
  "KiiivzI/uU//2Q==";
const ROLE_B_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoH" +
  "BwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQME" +
  "BAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU" +
  "FBQUFBQUFBQUFBQUFBT/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEA" +
  "AAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIh" +
  "MUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6" +
  "Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZ" +
  "mqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx" +
  "8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA" +
  "AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAV" +
  "YnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hp" +
  "anN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPE" +
  "xcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDy" +
  "qiiiv67PyQ//2Q==";

const ROLE_JPEGS = Object.freeze({
  A: Buffer.from(ROLE_A_JPEG_BASE64, "base64"),
  B: Buffer.from(ROLE_B_JPEG_BASE64, "base64")
});

function cliError(message) {
  return new TypeError(`${message}\n${USAGE}`);
}

function requireIpv4Host(value, label) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    !isIPv4(value.trim())
  ) {
    throw new TypeError(`${label} must be a valid IPv4 address`);
  }
  return value.trim();
}

function requireTcpPort(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError(`${label} must be an integer from 1 through 65535`);
  }
  return value;
}

function requireRole(role) {
  if (role !== "A" && role !== "B") {
    throw new TypeError('role must be either "A" or "B"');
  }
  return role;
}

export function parseCliArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw cliError("A non-empty deviceId is required.");
  }

  const rawDeviceId = args[0];
  if (
    typeof rawDeviceId !== "string" ||
    rawDeviceId.trim().length === 0 ||
    rawDeviceId.startsWith("--")
  ) {
    throw cliError("deviceId must be a non-empty first argument.");
  }
  const deviceId = rawDeviceId.trim();
  const remaining = args.slice(1);

  if (remaining.length === 0) {
    return { deviceId, directHost: null };
  }
  if (remaining[0] !== "--direct") {
    throw cliError(`Unknown argument: ${String(remaining[0])}`);
  }
  if (remaining.length === 1) {
    throw cliError("The --direct argument requires an IPv4 address.");
  }
  if (remaining.slice(2).includes("--direct")) {
    throw cliError("Duplicate --direct argument.");
  }
  if (remaining.length > 2) {
    throw cliError(`Unexpected argument: ${String(remaining[2])}`);
  }

  let directHost;
  try {
    directHost = requireIpv4Host(remaining[1], "--direct host");
  } catch (error) {
    throw cliError(error.message);
  }
  return { deviceId, directHost };
}

export function parseDiscoveryResponse(payload) {
  let text;
  if (typeof payload === "string") {
    text = payload;
  } else if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
    text = Buffer.from(payload).toString("utf8");
  } else {
    throw new TypeError("Discovery response must be text or bytes");
  }

  if (!text.startsWith(DISCOVERY_RESPONSE_PREFIX)) {
    throw new TypeError(
      `Discovery response must begin with "${DISCOVERY_RESPONSE_PREFIX}"`
    );
  }

  const suffix = text.slice(DISCOVERY_RESPONSE_PREFIX.length);
  if (suffix.trim().length === 0) {
    throw new TypeError("Discovery response JSON suffix is missing");
  }

  let parsed;
  try {
    parsed = JSON.parse(suffix);
  } catch (error) {
    throw new TypeError(`Discovery response JSON is invalid: ${error.message}`);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new TypeError("Discovery response JSON must be an object");
  }

  const host = requireIpv4Host(parsed.ip, "Discovery host");
  const port = requireTcpPort(parsed.port, "Discovery port");
  return { host, port };
}

export function createWebSocketUrl(host, port) {
  const validHost = requireIpv4Host(host, "WebSocket host");
  const validPort = requireTcpPort(port, "WebSocket port");
  return `ws://${validHost}:${validPort}/ws`;
}

function readRandom(random) {
  if (typeof random !== "function") {
    throw new TypeError("random must be a function");
  }
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError("random must return a number from 0 through 1");
  }
  return value;
}

function round(value, decimalPlaces = 1) {
  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
}

export function generateHealth(elapsedMs, random = Math.random, role = null) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new TypeError("elapsedMs must be a non-negative finite number");
  }

  const phase = (elapsedMs / 12_000) * Math.PI * 2;
  const dist = {
    markerToMarker: round(1.1 + Math.sin(phase) * 0.25, 3),
    selfToOwn: round(0.46 + Math.sin(phase + 0.7) * 0.07, 3),
    selfToOther: round(1.15 + Math.sin(phase + 1.4) * 0.22, 3)
  };

  const fps = round(70 + readRandom(random) * 5, 1);
  const cvHz = round(24 + readRandom(random) * 8, 1);
  const cvMs = round(8 + readRandom(random) * 12, 1);
  const batteryPct = round(55 + readRandom(random) * 45, 1);
  const dropoutRoll = readRandom(random);

  let markers = [10, 20];
  let trackingOk = true;
  if (dropoutRoll < 0.03) {
    markers = [20];
    dist.markerToMarker = null;
    dist[role === "B" ? "selfToOther" : "selfToOwn"] = null;
    trackingOk = false;
  } else if (dropoutRoll < 0.06) {
    markers = [10];
    dist.markerToMarker = null;
    dist[role === "B" ? "selfToOwn" : "selfToOther"] = null;
    trackingOk = false;
  }

  return {
    t: "health",
    fps,
    cvHz,
    cvMs,
    batteryPct,
    markers,
    dist,
    trackingOk
  };
}

export function getRoleJpeg(role) {
  return Buffer.from(ROLE_JPEGS[requireRole(role)]);
}

export function createRoleFrame(role) {
  const validRole = requireRole(role);
  return Buffer.concat([
    Buffer.from(validRole, "ascii"),
    getRoleJpeg(validRole)
  ]);
}

function discoverServer({
  signal,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
  retryMs = DISCOVERY_RETRY_MS
} = {}) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;
    let timeout;
    let retry;

    function closeSocket() {
      try {
        socket.close();
      } catch {
        // The socket may not have reached the bound state yet.
      }
    }

    function finish(error, endpoint) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(retry);
      signal?.removeEventListener("abort", onAbort);
      closeSocket();
      if (error) {
        reject(error);
      } else {
        resolve(endpoint);
      }
    }

    function onAbort() {
      const error = new Error("UDP discovery was aborted");
      error.name = "AbortError";
      finish(error);
    }

    function sendRequest() {
      if (settled) {
        return;
      }
      socket.send(
        DISCOVERY_REQUEST,
        DISCOVERY_PORT,
        DISCOVERY_ADDRESS,
        (error) => {
          if (error) {
            finish(
              new Error(`UDP discovery broadcast failed: ${error.message}`)
            );
          }
        }
      );
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    timeout = setTimeout(() => {
      finish(
        new Error(`UDP discovery timed out after ${timeoutMs}ms`)
      );
    }, timeoutMs);

    socket.once("error", (error) => {
      finish(new Error(`UDP discovery socket failed: ${error.message}`));
    });
    socket.on("message", (message) => {
      try {
        finish(null, parseDiscoveryResponse(message));
      } catch {
        // Ignore unrelated or malformed datagrams until the bounded timeout.
      }
    });
    socket.bind(0, "0.0.0.0", () => {
      if (settled) {
        return;
      }
      try {
        socket.setBroadcast(true);
      } catch (error) {
        finish(
          new Error(`Could not enable UDP broadcast: ${error.message}`)
        );
        return;
      }
      sendRequest();
      retry = setInterval(sendRequest, retryMs);
    });
  });
}

function createLogger(deviceId) {
  const prefix = `[mock:${deviceId}]`;
  return {
    info(message) {
      console.info(`${prefix} ${message}`);
    },
    warn(message) {
      console.warn(`${prefix} ${message}`);
    },
    error(message) {
      console.error(`${prefix} ${message}`);
    }
  };
}

function createMockQuest({ deviceId, directHost }) {
  const logger = createLogger(deviceId);
  const startedAtMs = Date.now();

  let stopped = false;
  let connecting = false;
  let webSocket = null;
  let welcomed = false;
  let role = null;
  let previewSource = "pca";
  let discoveryAbortController = null;
  let reconnectTimer = null;
  let healthTimer = null;
  let frameTimer = null;

  function socketIsOpen() {
    return webSocket?.readyState === WebSocket.OPEN;
  }

  function clearSessionTimers() {
    clearInterval(healthTimer);
    clearInterval(frameTimer);
    healthTimer = null;
    frameTimer = null;
  }

  function clearSession() {
    clearSessionTimers();
    welcomed = false;
    role = null;
  }

  function sendJson(message, requireWelcome = true) {
    if (
      stopped ||
      !socketIsOpen() ||
      (requireWelcome && !welcomed)
    ) {
      return false;
    }
    try {
      webSocket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      logger.warn(`JSON send failed: ${error.message}`);
      return false;
    }
  }

  function sendFrame(reason) {
    if (!welcomed || !socketIsOpen() || (role !== "A" && role !== "B")) {
      return false;
    }
    try {
      webSocket.send(createRoleFrame(role), { binary: true });
      logger.info(
        `frame role=${role} source=${previewSource} reason=${reason}`
      );
      return true;
    } catch (error) {
      logger.warn(`Frame send failed: ${error.message}`);
      return false;
    }
  }

  function updateRole(nextRole, source) {
    clearInterval(frameTimer);
    frameTimer = null;
    role = nextRole === "A" || nextRole === "B" ? nextRole : null;
    logger.info(
      `roleAssigned source=${source} role=${role ?? "null"}`
    );
    if (role !== null && welcomed && socketIsOpen()) {
      frameTimer = setInterval(
        () => sendFrame("periodic"),
        FRAME_INTERVAL_MS
      );
    }
  }

  function startHealth() {
    clearInterval(healthTimer);
    healthTimer = setInterval(() => {
      if (!welcomed || !socketIsOpen()) {
        return;
      }
      sendJson(
        generateHealth(Date.now() - startedAtMs, Math.random, role)
      );
    }, HEALTH_INTERVAL_MS);
  }

  function logSequenceState(seqState, source) {
    logger.info(`seqState source=${source} ${JSON.stringify(seqState)}`);
  }

  function handleServerMessage(data, isBinary) {
    if (isBinary) {
      return;
    }

    let message;
    try {
      message = JSON.parse(Buffer.from(data).toString("utf8"));
    } catch {
      logger.warn("Ignored malformed JSON from server");
      return;
    }
    if (
      message === null ||
      typeof message !== "object" ||
      typeof message.t !== "string"
    ) {
      logger.warn("Ignored invalid server message");
      return;
    }

    switch (message.t) {
      case "ping":
        if (
          typeof message.serverTimeMs === "number" &&
          Number.isFinite(message.serverTimeMs)
        ) {
          sendJson(
            {
              t: "pong",
              clientTimeMs: Date.now(),
              echoedServerTimeMs: message.serverTimeMs
            },
            false
          );
        }
        return;

      case "welcome":
        welcomed = true;
        logger.info(`welcome serverTimeMs=${String(message.serverTimeMs)}`);
        logSequenceState(message.seqState, "welcome");
        updateRole(message.role, "welcome");
        startHealth();
        return;

      case "seqState":
        logSequenceState(message, "broadcast");
        return;

      case "roleAssigned":
        updateRole(message.role, "roleAssigned");
        return;

      case "requestFrame":
        if (message.role === role) {
          sendFrame("requestFrame");
        } else {
          logger.warn(
            `Ignored requestFrame for role=${String(message.role)}`
          );
        }
        return;

      case "previewSource":
        if (message.source === "eye" || message.source === "pca") {
          previewSource = message.source;
          logger.info(
            `previewSource role=${String(message.role)} source=${previewSource}`
          );
        } else {
          logger.warn(
            `Ignored previewSource=${String(message.source)}`
          );
        }
        return;

      case "error":
        logger.warn(
          `server error code=${String(message.code)} message=${String(
            message.message
          )}`
        );
        return;

      default:
        return;
    }
  }

  function scheduleReconnect(reason) {
    if (stopped || reconnectTimer !== null) {
      return;
    }
    logger.warn(`${reason}; reconnecting in ${RECONNECT_INTERVAL_MS}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, RECONNECT_INTERVAL_MS);
  }

  function attachWebSocket(url) {
    const nextWebSocket = new WebSocket(url);
    webSocket = nextWebSocket;

    nextWebSocket.on("open", () => {
      if (stopped || webSocket !== nextWebSocket) {
        nextWebSocket.terminate();
        return;
      }
      logger.info(`connected ${url}`);
      sendJson(
        {
          t: "hello",
          clientType: "quest",
          deviceId,
          appVersion: APP_VERSION
        },
        false
      );
    });

    nextWebSocket.on("message", (data, isBinary) => {
      if (!stopped && webSocket === nextWebSocket) {
        handleServerMessage(data, isBinary);
      }
    });

    nextWebSocket.on("close", (code, reason) => {
      if (webSocket !== nextWebSocket) {
        return;
      }
      webSocket = null;
      clearSession();
      logger.warn(
        `disconnected code=${code} reason=${Buffer.from(reason).toString(
          "utf8"
        )}`
      );
      scheduleReconnect("WebSocket closed");
    });

    nextWebSocket.on("error", (error) => {
      if (!stopped && webSocket === nextWebSocket) {
        logger.warn(`WebSocket error: ${error.message}`);
      }
    });
  }

  async function connect() {
    if (stopped || connecting || webSocket !== null) {
      return;
    }
    connecting = true;

    try {
      let endpoint;
      if (directHost !== null) {
        endpoint = { host: directHost, port: DIRECT_PORT };
      } else {
        logger.info(
          `discovering via UDP ${DISCOVERY_ADDRESS}:${DISCOVERY_PORT}`
        );
        const abortController = new AbortController();
        discoveryAbortController = abortController;
        endpoint = await discoverServer({
          signal: abortController.signal
        });
        if (discoveryAbortController === abortController) {
          discoveryAbortController = null;
        }
        logger.info(
          `discovered server ${endpoint.host}:${endpoint.port}`
        );
      }

      if (!stopped) {
        attachWebSocket(
          createWebSocketUrl(endpoint.host, endpoint.port)
        );
      }
    } catch (error) {
      if (!stopped) {
        logger.warn(`Connection attempt failed: ${error.message}`);
        scheduleReconnect("Connection attempt failed");
      }
    } finally {
      connecting = false;
      discoveryAbortController = null;
    }
  }

  function start() {
    logger.info(
      directHost === null
        ? "starting in UDP discovery mode"
        : `starting in direct mode (${directHost}:${DIRECT_PORT})`
    );
    void connect();
  }

  function stop(signal = "shutdown") {
    if (stopped) {
      return;
    }
    stopped = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    discoveryAbortController?.abort();
    discoveryAbortController = null;
    clearSession();

    const closingWebSocket = webSocket;
    webSocket = null;
    if (closingWebSocket !== null) {
      closingWebSocket.terminate();
    }
    logger.info(`${signal} received; sockets and timers cleaned up`);
  }

  return { start, stop };
}

function isCommandLineEntryPoint() {
  if (!process.argv[1]) {
    return false;
  }
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

function main() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[mock] ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const client = createMockQuest(options);
  client.start();

  let shuttingDown = false;
  function shutDown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    client.stop(signal);
  }

  process.once("SIGINT", () => shutDown("SIGINT"));
  process.once("SIGTERM", () => shutDown("SIGTERM"));
}

if (isCommandLineEntryPoint()) {
  main();
}
