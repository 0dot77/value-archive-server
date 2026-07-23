import assert from "node:assert/strict";
import dgram from "node:dgram";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import WebSocket from "ws";

import { createValueArchiveServer } from "../src/server.js";

const sequenceFixture = {
  sequenceId: "performance-v1",
  steps: [
    {
      stepId: "intro",
      title: "Intro",
      targets: ["A", "B"],
      trigger: { type: "manual" },
      params: { cue: "standby" }
    },
    {
      stepId: "approach",
      title: "Approach",
      targets: ["A", "B"],
      trigger: { type: "manual" },
      params: { cue: "move" }
    }
  ]
};

const completeHealth = {
  fps: 72,
  cvHz: 30,
  cvMs: 8.5,
  batteryPct: 88,
  markers: [10, 20],
  dist: {
    markerToMarker: 0.42,
    selfToOwn: 0.21,
    selfToOther: null
  },
  trackingOk: true
};

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createMessageInbox(webSocket) {
  const queued = [];
  const waiters = [];

  function matches(predicate, item) {
    try {
      return predicate(item);
    } catch {
      return false;
    }
  }

  function deliver(item) {
    const waiterIndex = waiters.findIndex((waiter) =>
      matches(waiter.predicate, item)
    );
    if (waiterIndex === -1) {
      queued.push(item);
      return;
    }

    const [waiter] = waiters.splice(waiterIndex, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(item);
  }

  webSocket.on("message", (data, isBinary) => {
    const bytes = Buffer.from(data);
    let json;

    if (!isBinary) {
      try {
        json = JSON.parse(bytes.toString("utf8"));
      } catch {
        json = undefined;
      }
    }

    deliver({ isBinary, bytes, json });
  });

  function next(predicate, label = "matching WebSocket message", timeoutMs = 1000) {
    const queuedIndex = queued.findIndex((item) => matches(predicate, item));
    if (queuedIndex !== -1) {
      return Promise.resolve(queued.splice(queuedIndex, 1)[0]);
    }

    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        const waiterIndex = waiters.indexOf(waiter);
        if (waiterIndex !== -1) {
          waiters.splice(waiterIndex, 1);
        }
        reject(new Error(`Timed out waiting for ${label}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  return {
    next,
    nextJson(type, predicate = () => true, timeoutMs = 1000) {
      return next(
        (item) =>
          !item.isBinary &&
          item.json?.t === type &&
          predicate(item.json),
        `JSON message ${type}`,
        timeoutMs
      ).then((item) => item.json);
    },
    nextBinary(predicate = () => true, timeoutMs = 1000) {
      return next(
        (item) => item.isBinary && predicate(item.bytes),
        "binary WebSocket message",
        timeoutMs
      ).then((item) => item.bytes);
    }
  };
}

async function openPeer(t, url) {
  const webSocket = new WebSocket(url);
  const inbox = createMessageInbox(webSocket);

  await new Promise((resolve, reject) => {
    webSocket.once("open", resolve);
    webSocket.once("error", reject);
  });

  const peer = {
    webSocket,
    ...inbox,
    sendJson(message) {
      webSocket.send(JSON.stringify(message));
    },
    sendBinary(bytes) {
      webSocket.send(bytes, { binary: true });
    },
    async close() {
      if (webSocket.readyState === WebSocket.CLOSED) {
        return;
      }
      if (webSocket.readyState === WebSocket.CONNECTING) {
        webSocket.terminate();
        return;
      }

      await new Promise((resolve) => {
        const forceTimer = setTimeout(() => webSocket.terminate(), 100);
        webSocket.once("close", () => {
          clearTimeout(forceTimer);
          resolve();
        });
        webSocket.close();
      });
    }
  };

  t.after(() => peer.close());
  return peer;
}

async function waitForPeerClose(peer, timeoutMs = 1000) {
  if (peer.webSocket.readyState === WebSocket.CLOSED) {
    return;
  }

  await Promise.race([
    new Promise((resolve) => peer.webSocket.once("close", resolve)),
    delay(timeoutMs).then(() => {
      throw new Error("Timed out waiting for WebSocket close");
    })
  ]);
}

async function assertNoBinary(peer, timeoutMs = 80) {
  await assert.rejects(
    peer.nextBinary(() => true, timeoutMs),
    /Timed out waiting for binary/
  );
}

async function createFixtureFiles({
  assignments = {},
  sequence = sequenceFixture
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "va-server-"));
  const registryFilePath = path.join(directory, "devices.json");
  const sequenceFilePath = path.join(directory, "sequence.json");
  await Promise.all([
    writeFile(registryFilePath, JSON.stringify(assignments), "utf8"),
    writeFile(sequenceFilePath, JSON.stringify(sequence), "utf8")
  ]);
  return { directory, registryFilePath, sequenceFilePath };
}

async function createRunningServer(t, fixtureOptions = {}, serverOptions = {}) {
  const fixture = await createFixtureFiles(fixtureOptions);
  const logs = [];
  const logger = Object.fromEntries(
    ["log", "info", "warn", "error"].map((level) => [
      level,
      (message) => logs.push({ level, message: String(message) })
    ])
  );
  const server = createValueArchiveServer({
    registryFilePath: fixture.registryFilePath,
    sequenceFilePath: fixture.sequenceFilePath,
    httpHost: "127.0.0.1",
    httpPort: 0,
    udpHost: "127.0.0.1",
    udpPort: 0,
    advertiseIp: "192.0.2.44",
    pingIntervalMs: 35,
    deviceUpdateIntervalMs: 20,
    offlineTimeoutMs: 110,
    logger,
    ...serverOptions
  });

  try {
    await server.start();
  } catch (error) {
    await rm(fixture.directory, { recursive: true, force: true });
    throw error;
  }

  t.after(async () => {
    await server.stop();
    await rm(fixture.directory, { recursive: true, force: true });
  });

  const addresses = server.address();
  return {
    ...fixture,
    logs,
    server,
    addresses,
    httpBaseUrl: `http://127.0.0.1:${addresses.http.port}`,
    wsUrl: `ws://127.0.0.1:${addresses.http.port}/ws`
  };
}

async function requestJson(url, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, json: await response.json() };
}

function deviceFrom(message, deviceId) {
  return message.devices.find((device) => device.deviceId === deviceId);
}

async function expectRejectedUpgrade(url) {
  return new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url);
    const timer = setTimeout(() => {
      webSocket.terminate();
      reject(new Error(`Timed out waiting for rejected upgrade at ${url}`));
    }, 1000);

    webSocket.once("open", () => {
      clearTimeout(timer);
      webSocket.terminate();
      reject(new Error(`Unexpectedly upgraded ${url}`));
    });
    webSocket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      const statusCode = response.statusCode;
      response.resume();
      webSocket.on("error", () => {});
      resolve(statusCode);
    });
    webSocket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function discover(udpPort) {
  const socket = dgram.createSocket("udp4");

  try {
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, "127.0.0.1", resolve);
    });

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for UDP discovery response")),
        1000
      );
      socket.once("message", (message) => {
        clearTimeout(timer);
        resolve(message.toString("utf8"));
      });
      socket.send(
        Buffer.from("VA_DISCOVER?"),
        udpPort,
        "127.0.0.1",
        (error) => {
          if (error) {
            clearTimeout(timer);
            reject(error);
          }
        }
      );
    });
  } finally {
    socket.close();
  }
}

test("serves exact REST state and validates assignment and sequence commands", async (t) => {
  const fixture = await createRunningServer(t);

  assert.notEqual(fixture.addresses.http.port, 0);
  assert.notEqual(fixture.addresses.udp.port, 0);
  assert.equal(fixture.addresses.advertiseIp, "192.0.2.44");
  assert.ok(fixture.logs.length > 0);
  assert.ok(fixture.logs.every(({ message }) => message.startsWith("[VA]")));

  const initial = await requestJson(`${fixture.httpBaseUrl}/api/state`);
  assert.equal(initial.response.status, 200);
  assert.deepEqual(Object.keys(initial.json), [
    "devices",
    "seqState",
    "sequence"
  ]);
  assert.deepEqual(initial.json.devices, []);
  assert.deepEqual(initial.json.sequence, sequenceFixture);
  assert.deepEqual(
    {
      ...initial.json.seqState,
      enteredAtServerMs: 0
    },
    {
      sequenceId: "performance-v1",
      running: false,
      stepIndex: 0,
      stepId: "intro",
      enteredAtServerMs: 0,
      params: { cue: "standby" }
    }
  );

  const stateCopy = fixture.server.getState();
  stateCopy.sequence.steps[0].title = "mutated";
  stateCopy.seqState.params.cue = "mutated";
  assert.equal(fixture.server.getState().sequence.steps[0].title, "Intro");
  assert.equal(fixture.server.getState().seqState.params.cue, "standby");

  for (const body of [
    { deviceId: "", role: "A" },
    { deviceId: "quest-rest", role: "C" },
    null
  ]) {
    const invalid = await requestJson(`${fixture.httpBaseUrl}/api/assign`, {
      method: "POST",
      body
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.json.ok, false);
    assert.equal(typeof invalid.json.error?.code, "string");
    assert.equal(typeof invalid.json.error?.message, "string");
  }

  const assigned = await requestJson(`${fixture.httpBaseUrl}/api/assign`, {
    method: "POST",
    body: { deviceId: "quest-rest", role: "A" }
  });
  assert.equal(assigned.response.status, 200);
  assert.equal(assigned.json.ok, true);
  assert.deepEqual(
    JSON.parse(await readFile(fixture.registryFilePath, "utf8")),
    { "quest-rest": "A" }
  );

  const invalidSequence = await requestJson(`${fixture.httpBaseUrl}/api/seq`, {
    method: "POST",
    body: { action: "goto", stepIndex: 99 }
  });
  assert.equal(invalidSequence.response.status, 400);
  assert.equal(invalidSequence.json.ok, false);
  assert.match(invalidSequence.json.error.message, /goto|stepIndex/i);

  const started = await requestJson(`${fixture.httpBaseUrl}/api/seq`, {
    method: "POST",
    body: { action: "start" }
  });
  assert.equal(started.response.status, 200);
  assert.equal(started.json.ok, true);
  assert.equal(started.json.seqState.running, true);
  assert.equal(started.json.seqState.stepIndex, 0);

  const current = await requestJson(`${fixture.httpBaseUrl}/api/state`);
  assert.equal(current.json.seqState.running, true);
});

test("uses separate welcomes and tracks grace, health, RTT, malformed JSON, and offline state", async (t) => {
  const fixture = await createRunningServer(t, {
    assignments: { "quest-alpha": "A" }
  });
  const dashboard = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  const dashboardWelcome = await dashboard.nextJson("welcome");
  assert.deepEqual(Object.keys(dashboardWelcome), [
    "t",
    "serverTimeMs",
    "devices",
    "seqState",
    "sequence"
  ]);
  assert.deepEqual(dashboardWelcome.devices, []);
  assert.deepEqual(dashboardWelcome.sequence, sequenceFixture);

  const unwelcomed = await openPeer(t, fixture.wsUrl);
  unwelcomed.sendJson({ t: "health", fps: 999 });

  const quest = await openPeer(t, fixture.wsUrl);
  quest.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-alpha",
    appVersion: "test"
  });
  const questWelcome = await quest.nextJson("welcome");
  assert.deepEqual(Object.keys(questWelcome), [
    "t",
    "role",
    "serverTimeMs",
    "seqState"
  ]);
  assert.equal(questWelcome.role, "A");
  assert.equal(typeof questWelcome.serverTimeMs, "number");
  assert.equal(questWelcome.seqState.stepId, "intro");
  assert.deepEqual(await quest.nextJson("previewSource"), {
    t: "previewSource",
    role: "A",
    source: "pca"
  });

  const graceUpdate = await dashboard.nextJson(
    "deviceUpdate",
    (message) => deviceFrom(message, "quest-alpha")?.online === true
  );
  assert.deepEqual(deviceFrom(graceUpdate, "quest-alpha"), {
    deviceId: "quest-alpha",
    role: "A",
    online: true,
    rttMs: null,
    lastHealth: null,
    lastSeenMs: null
  });
  assert.equal(fixture.server.getState().devices.length, 1);

  const dashboardPing = await dashboard.nextJson("ping");
  assert.equal(typeof dashboardPing.serverTimeMs, "number");
  const questPing = await quest.nextJson("ping");
  quest.sendJson({
    t: "pong",
    clientTimeMs: Date.now(),
    echoedServerTimeMs: questPing.serverTimeMs
  });
  const rttUpdate = await dashboard.nextJson(
    "deviceUpdate",
    (message) =>
      Number.isFinite(deviceFrom(message, "quest-alpha")?.rttMs)
  );
  assert.ok(deviceFrom(rttUpdate, "quest-alpha").rttMs >= 0);

  quest.webSocket.send("{");
  quest.sendJson({ t: "health", ...completeHealth });
  const healthyUpdate = await dashboard.nextJson(
    "deviceUpdate",
    (message) =>
      deviceFrom(message, "quest-alpha")?.lastHealth?.fps === 72
  );
  const healthyDevice = deviceFrom(healthyUpdate, "quest-alpha");
  assert.deepEqual(healthyDevice.lastHealth, completeHealth);
  assert.equal(typeof healthyDevice.lastSeenMs, "number");
  assert.equal(healthyDevice.online, true);
  assert.equal(quest.webSocket.readyState, WebSocket.OPEN);

  dashboard.sendJson({ t: "health", ...completeHealth, fps: 1 });
  await delay(25);
  assert.equal(fixture.server.getState().devices.length, 1);

  const offlineUpdate = await dashboard.nextJson(
    "deviceUpdate",
    (message) => {
      const device = deviceFrom(message, "quest-alpha");
      return (
        device?.online === false &&
        device.lastSeenMs === healthyDevice.lastSeenMs
      );
    },
    1000
  );
  assert.deepEqual(
    deviceFrom(offlineUpdate, "quest-alpha").lastHealth,
    completeHealth
  );

  quest.sendJson({ t: "health", fps: "not-a-number" });
  await delay(25);
  const afterInvalidHealth = deviceFrom(
    fixture.server.getState(),
    "quest-alpha"
  );
  assert.equal(afterInvalidHealth.online, false);
  assert.equal(afterInvalidHealth.lastSeenMs, healthyDevice.lastSeenMs);
  assert.deepEqual(afterInvalidHealth.lastHealth, completeHealth);

  quest.sendJson({
    t: "health",
    ...completeHealth,
    batteryPct: 87
  });
  const restoredUpdate = await dashboard.nextJson(
    "deviceUpdate",
    (message) => {
      const device = deviceFrom(message, "quest-alpha");
      return device?.online === true && device.lastHealth?.batteryPct === 87;
    }
  );
  const restoredLastSeenMs = deviceFrom(
    restoredUpdate,
    "quest-alpha"
  ).lastSeenMs;
  assert.ok(restoredLastSeenMs > healthyDevice.lastSeenMs);

  await quest.close();
  const closedUpdate = await dashboard.nextJson(
    "deviceUpdate",
    (message) => {
      const device = deviceFrom(message, "quest-alpha");
      return (
        device?.online === false &&
        device.lastSeenMs === restoredLastSeenMs
      );
    }
  );
  assert.equal(deviceFrom(closedUpdate, "quest-alpha").online, false);
});

test("accepts a dashboard pong without emitting an error", async (t) => {
  const fixture = await createRunningServer(t);
  const dashboard = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  await dashboard.nextJson("welcome");

  const ping = await dashboard.nextJson("ping");
  dashboard.sendJson({
    t: "pong",
    clientTimeMs: Date.now(),
    echoedServerTimeMs: ping.serverTimeMs
  });

  const unexpectedError = await dashboard
    .nextJson("error", () => true, 80)
    .catch((error) => {
      assert.match(error.message, /Timed out waiting for JSON message error/);
      return null;
    });
  assert.equal(
    unexpectedError,
    null,
    `unexpected dashboard error: ${JSON.stringify(unexpectedError)}`
  );
});

test("rejects dashboard pongs whose timestamps are not finite numbers", async (t) => {
  const fixture = await createRunningServer(t);
  const dashboard = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  await dashboard.nextJson("welcome");
  const ping = await dashboard.nextJson("ping");

  for (const pong of [
    {
      t: "pong",
      clientTimeMs: null,
      echoedServerTimeMs: ping.serverTimeMs
    },
    {
      t: "pong",
      clientTimeMs: Date.now(),
      echoedServerTimeMs: "not-a-number"
    }
  ]) {
    dashboard.sendJson(pong);
    const error = await dashboard.nextJson("error");
    assert.equal(error.code, "INVALID_CONTROL");
  }
});

test("persists role theft before notices, retains preview source, and gates binary relay by identity", async (t) => {
  const fixture = await createRunningServer(t);
  const dashboard = await openPeer(t, fixture.wsUrl);
  const displacedQuest = await openPeer(t, fixture.wsUrl);
  const newQuest = await openPeer(t, fixture.wsUrl);

  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  displacedQuest.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-z"
  });
  newQuest.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-a"
  });
  await Promise.all([
    dashboard.nextJson("welcome"),
    displacedQuest.nextJson("welcome"),
    newQuest.nextJson("welcome")
  ]);

  dashboard.sendJson({
    t: "assignRole",
    deviceId: "quest-z",
    role: "A"
  });
  assert.deepEqual(await displacedQuest.nextJson("roleAssigned"), {
    t: "roleAssigned",
    role: "A"
  });
  assert.deepEqual(await displacedQuest.nextJson("previewSource"), {
    t: "previewSource",
    role: "A",
    source: "pca"
  });

  dashboard.sendJson({ t: "requestFrame", role: "B" });
  const unavailable = await dashboard.nextJson("error");
  assert.deepEqual(Object.keys(unavailable), ["t", "code", "message"]);
  assert.match(unavailable.code, /unavailable/i);

  dashboard.sendJson({
    t: "previewSource",
    role: "A",
    source: "invalid"
  });
  const invalidSource = await dashboard.nextJson("error");
  assert.deepEqual(Object.keys(invalidSource), ["t", "code", "message"]);
  assert.match(invalidSource.message, /source/i);

  dashboard.sendJson({ t: "requestFrame", role: "A" });
  assert.deepEqual(await displacedQuest.nextJson("requestFrame"), {
    t: "requestFrame",
    role: "A"
  });
  dashboard.sendJson({
    t: "previewSource",
    role: "A",
    source: "eye"
  });
  assert.deepEqual(await displacedQuest.nextJson("previewSource"), {
    t: "previewSource",
    role: "A",
    source: "eye"
  });

  const acceptedFrame = Buffer.from([0x41, 0xff, 0xd8, 0xff, 0xd9]);
  displacedQuest.sendBinary(acceptedFrame);
  assert.deepEqual(await dashboard.nextBinary(), acceptedFrame);

  displacedQuest.sendBinary(Buffer.from([0x42, 1, 2]));
  displacedQuest.sendBinary(Buffer.from([0x41]));
  newQuest.sendBinary(Buffer.from([0x41, 3, 4]));
  await assertNoBinary(dashboard);

  dashboard.sendJson({
    t: "assignRole",
    deviceId: "quest-a",
    role: "A"
  });
  const [newNotice, displacedNotice] = await Promise.all([
    newQuest.nextJson("roleAssigned"),
    displacedQuest.nextJson("roleAssigned", (message) => message.role === null)
  ]);
  assert.deepEqual(newNotice, { t: "roleAssigned", role: "A" });
  assert.deepEqual(displacedNotice, { t: "roleAssigned", role: null });
  assert.deepEqual(
    JSON.parse(await readFile(fixture.registryFilePath, "utf8")),
    { "quest-a": "A" }
  );
  assert.deepEqual(await newQuest.nextJson("previewSource"), {
    t: "previewSource",
    role: "A",
    source: "eye"
  });
  assert.ok(
    fixture.logs.some(({ message }) =>
      /quest-z.*quest-a|quest-a.*quest-z/i.test(message)
    )
  );

  const stolenFrame = Buffer.from([0x41, 9, 9, 9]);
  displacedQuest.sendBinary(stolenFrame);
  await assertNoBinary(dashboard);
  const replacementFrame = Buffer.from([0x41, 7, 8, 9]);
  newQuest.sendBinary(replacementFrame);
  assert.deepEqual(await dashboard.nextBinary(), replacementFrame);

  displacedQuest.sendJson({
    t: "assignRole",
    deviceId: "quest-z",
    role: "B"
  });
  dashboard.sendBinary(Buffer.from([0x41, 5, 5]));
  await delay(35);
  assert.deepEqual(
    JSON.parse(await readFile(fixture.registryFilePath, "utf8")),
    { "quest-a": "A" }
  );
  await assertNoBinary(displacedQuest, 50);
  await assertNoBinary(newQuest, 50);

  const sortedUpdate = await dashboard.nextJson(
    "deviceUpdate",
    (message) =>
      deviceFrom(message, "quest-a")?.role === "A" &&
      deviceFrom(message, "quest-z")?.role === null
  );
  assert.deepEqual(
    sortedUpdate.devices.map(({ deviceId }) => deviceId),
    ["quest-a", "quest-z"]
  );
});

test("serializes back-to-back role assignments so the displaced Quest is always notified", async (t) => {
  const fixture = await createRunningServer(t);
  const dashboard = await openPeer(t, fixture.wsUrl);
  const firstQuest = await openPeer(t, fixture.wsUrl);
  const secondQuest = await openPeer(t, fixture.wsUrl);

  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  firstQuest.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-first"
  });
  secondQuest.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-second"
  });
  await Promise.all([
    dashboard.nextJson("welcome"),
    firstQuest.nextJson("welcome"),
    secondQuest.nextJson("welcome")
  ]);

  dashboard.sendJson({
    t: "assignRole",
    deviceId: "quest-first",
    role: "A"
  });
  dashboard.sendJson({
    t: "assignRole",
    deviceId: "quest-second",
    role: "A"
  });

  assert.equal((await firstQuest.nextJson("roleAssigned")).role, "A");
  assert.equal((await secondQuest.nextJson("roleAssigned")).role, "A");
  assert.deepEqual(
    await firstQuest.nextJson(
      "roleAssigned",
      (message) => message.role === null
    ),
    { t: "roleAssigned", role: null }
  );
  assert.deepEqual(
    JSON.parse(await readFile(fixture.registryFilePath, "utf8")),
    { "quest-second": "A" }
  );
});

test("orders preview controls after a preceding asynchronous role assignment", async (t) => {
  const fixture = await createRunningServer(t);
  const dashboard = await openPeer(t, fixture.wsUrl);
  const quest = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  quest.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-ordered"
  });
  await Promise.all([
    dashboard.nextJson("welcome"),
    quest.nextJson("welcome")
  ]);

  dashboard.sendJson({
    t: "assignRole",
    deviceId: "quest-ordered",
    role: "B"
  });
  dashboard.sendJson({ t: "requestFrame", role: "B" });
  dashboard.sendJson({
    t: "previewSource",
    role: "B",
    source: "eye"
  });

  assert.deepEqual(await quest.nextJson("roleAssigned"), {
    t: "roleAssigned",
    role: "B"
  });
  assert.deepEqual(await quest.nextJson("requestFrame"), {
    t: "requestFrame",
    role: "B"
  });
  assert.deepEqual(
    await quest.nextJson(
      "previewSource",
      (message) => message.source === "eye"
    ),
    {
      t: "previewSource",
      role: "B",
      source: "eye"
    }
  );
  await assert.rejects(
    dashboard.nextJson("error", () => true, 60),
    /Timed out waiting for JSON message error/
  );
});

test("stop drains queued WebSocket assignments before resolving or restarting", async (t) => {
  const fixture = await createRunningServer(t);
  const dashboard = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  await dashboard.nextJson("welcome");

  for (let index = 0; index < 120; index += 1) {
    dashboard.sendJson({
      t: "assignRole",
      deviceId: `queued-${index}`,
      role: "A"
    });
  }
  dashboard.sendJson({ t: "assignmentBarrier" });
  assert.equal(
    (await dashboard.nextJson("error")).code,
    "UNKNOWN_MESSAGE"
  );

  await fixture.server.stop();
  const expectedAssignments = { "queued-119": "A" };
  assert.deepEqual(
    JSON.parse(await readFile(fixture.registryFilePath, "utf8")),
    expectedAssignments
  );

  await fixture.server.start();
  await delay(100);
  assert.deepEqual(
    JSON.parse(await readFile(fixture.registryFilePath, "utf8")),
    expectedAssignments
  );
});

test("allows only dashboards to drive sequence state and broadcasts REST and WS transitions", async (t) => {
  const fixture = await createRunningServer(t);
  const dashboard = await openPeer(t, fixture.wsUrl);
  const quest = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  quest.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-sequence"
  });
  await Promise.all([
    dashboard.nextJson("welcome"),
    quest.nextJson("welcome")
  ]);

  dashboard.sendJson({ t: "seqCommand", action: "next" });
  const [dashboardNext, questNext] = await Promise.all([
    dashboard.nextJson("seqState", (message) => message.stepIndex === 1),
    quest.nextJson("seqState", (message) => message.stepIndex === 1)
  ]);
  assert.equal(dashboardNext.stepId, "approach");
  assert.equal(questNext.stepId, "approach");
  assert.deepEqual(Object.keys(dashboardNext), [
    "t",
    "sequenceId",
    "running",
    "stepIndex",
    "stepId",
    "enteredAtServerMs",
    "params"
  ]);

  quest.sendJson({ t: "seqCommand", action: "prev" });
  await delay(30);
  assert.equal(fixture.server.getState().seqState.stepIndex, 1);

  dashboard.sendJson({
    t: "seqCommand",
    action: "goto",
    stepIndex: 99
  });
  const invalid = await dashboard.nextJson("error");
  assert.deepEqual(Object.keys(invalid), ["t", "code", "message"]);
  assert.match(invalid.message, /goto|stepIndex/i);
  assert.equal(fixture.server.getState().seqState.stepIndex, 1);

  const stopped = await requestJson(`${fixture.httpBaseUrl}/api/seq`, {
    method: "POST",
    body: { action: "stop" }
  });
  assert.equal(stopped.response.status, 200);
  const [dashboardStop, questStop] = await Promise.all([
    dashboard.nextJson("seqState", (message) => message.running === false),
    quest.nextJson("seqState", (message) => message.running === false)
  ]);
  assert.equal(dashboardStop.stepIndex, 1);
  assert.equal(questStop.stepIndex, 1);
});

test("rejects WebSocket upgrades outside the exact /ws pathname", async (t) => {
  const fixture = await createRunningServer(t);
  assert.equal(
    await expectRejectedUpgrade(
      `ws://127.0.0.1:${fixture.addresses.http.port}/ws-extra`
    ),
    404
  );
  assert.equal(
    await expectRejectedUpgrade(
      `ws://127.0.0.1:${fixture.addresses.http.port}/`
    ),
    404
  );

  const withQuery = await openPeer(t, `${fixture.wsUrl}?client=test`);
  withQuery.sendJson({ t: "hello", clientType: "dashboard" });
  assert.equal((await withQuery.nextJson("welcome")).t, "welcome");
});

test("answers exact UDP discovery with the selected IP and actual ephemeral HTTP port", async (t) => {
  const fixture = await createRunningServer(t);
  const response = await discover(fixture.addresses.udp.port);

  assert.equal(
    response,
    `VA_SERVER ${JSON.stringify({
      ip: "192.0.2.44",
      port: fixture.addresses.http.port
    })}`
  );
});

test("logs concise sanitized operational events for a complete venue network flow", async (t) => {
  const fixture = await createRunningServer(t);
  const deviceId = 'quest-"logger"\n[VA] forged-device-line';
  const appVersion = '1.2.3\n[VA] forged-version-line';
  const dashboard = await openPeer(t, fixture.wsUrl);
  const quest = await openPeer(t, fixture.wsUrl);

  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  quest.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId,
    appVersion
  });
  await Promise.all([
    dashboard.nextJson("welcome"),
    quest.nextJson("welcome")
  ]);

  dashboard.sendJson({ t: "assignRole", deviceId, role: "A" });
  await quest.nextJson("roleAssigned", (message) => message.role === "A");
  dashboard.sendJson({ t: "seqCommand", action: "next" });
  await dashboard.nextJson("seqState", (message) => message.stepIndex === 1);
  assert.equal(
    await discover(fixture.addresses.udp.port),
    `VA_SERVER ${JSON.stringify({
      ip: "192.0.2.44",
      port: fixture.addresses.http.port
    })}`
  );

  await quest.close();
  await dashboard.close();

  const serializedDeviceId = JSON.stringify(deviceId);
  const serializedAppVersion = JSON.stringify(appVersion);
  const advertisedEndpoint = JSON.stringify(
    `192.0.2.44:${fixture.addresses.http.port}`
  );
  const requiredEntries = [
    {
      label: "dashboard connected",
      matches: (message) => message === "[VA] Dashboard connected"
    },
    {
      label: "Quest connected with identity, version, and role",
      matches: (message) =>
        message ===
        `[VA] Quest connected deviceId=${serializedDeviceId} ` +
          `appVersion=${serializedAppVersion} role=null`
    },
    {
      label: "ordinary role assignment",
      matches: (message) =>
        message ===
        `[VA] Role assigned deviceId=${serializedDeviceId} role="A"`
    },
    {
      label: "UDP discovery reply with endpoints",
      matches: (message) =>
        message.startsWith(
          '[VA] UDP discovery reply remote="127.0.0.1:'
        ) && message.endsWith(`" advertised=${advertisedEndpoint}`)
    },
    {
      label: "sequence transition",
      matches: (message) =>
        message ===
        '[VA] Sequence action="next" running=false ' +
          'stepIndex=1 stepId="approach"'
    },
    {
      label: "Quest disconnected",
      matches: (message) =>
        message ===
        `[VA] Quest disconnected deviceId=${serializedDeviceId}`
    },
    {
      label: "dashboard disconnected",
      matches: (message) => message === "[VA] Dashboard disconnected"
    }
  ];

  let messages;
  let missingLabels;
  const deadline = Date.now() + 300;
  do {
    messages = fixture.logs.map(({ message }) => message);
    missingLabels = requiredEntries
      .filter(({ matches }) => !messages.some(matches))
      .map(({ label }) => label);
    if (missingLabels.length === 0) {
      break;
    }
    await delay(10);
  } while (Date.now() < deadline);

  assert.deepEqual(
    missingLabels,
    [],
    `missing operational logs; captured:\n${messages.join("\n")}`
  );
  assert.equal(
    messages.some((message) => /[\r\n]/.test(message)),
    false,
    "untrusted values must not create additional log lines"
  );
  assert.equal(
    messages.some((message) => /\b(?:health|frame|ping|pong)\b/i.test(message)),
    false,
    "high-frequency protocol messages must not be logged"
  );
  assert.ok(messages.every((message) => message.startsWith("[VA]")));
});

test("a duplicate device connection replaces the old socket without marking the replacement offline", async (t) => {
  const fixture = await createRunningServer(t, {
    assignments: { "quest-duplicate": "B" }
  });
  const dashboard = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  await dashboard.nextJson("welcome");

  const original = await openPeer(t, fixture.wsUrl);
  original.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-duplicate"
  });
  assert.equal((await original.nextJson("welcome")).role, "B");

  const replacement = await openPeer(t, fixture.wsUrl);
  replacement.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-duplicate"
  });
  assert.equal((await replacement.nextJson("welcome")).role, "B");
  await waitForPeerClose(original);

  replacement.sendJson({
    t: "health",
    ...completeHealth,
    fps: 80
  });
  const replacementUpdate = await dashboard.nextJson(
    "deviceUpdate",
    (message) => {
      const device = deviceFrom(message, "quest-duplicate");
      return device?.online === true && device.lastHealth?.fps === 80;
    }
  );
  await delay(30);
  assert.equal(
    deviceFrom(replacementUpdate, "quest-duplicate").role,
    "B"
  );
  assert.equal(fixture.server.getState().devices[0].online, true);
  assert.equal(fixture.server.getState().devices.length, 1);
});

test("stop closes a raw HTTP connection with incomplete request headers", async (t) => {
  const fixture = await createRunningServer(t);
  const socket = createConnection({
    host: "127.0.0.1",
    port: fixture.addresses.http.port
  });
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  await new Promise((resolve, reject) => {
    socket.write(
      "GET /api/state HTTP/1.1\r\nHost: localhost\r\n",
      (error) => (error ? reject(error) : resolve())
    );
  });
  await delay(10);

  const stopping = fixture.server.stop();
  const stoppedPromptly = await Promise.race([
    stopping.then(() => true),
    delay(300).then(() => false)
  ]);
  if (!stoppedPromptly) {
    socket.destroy();
    await stopping;
  }

  assert.equal(stoppedPromptly, true);
  if (!socket.destroyed) {
    await Promise.race([
      new Promise((resolve) => socket.once("close", resolve)),
      delay(300).then(() => {
        throw new Error("Timed out waiting for raw HTTP socket close");
      })
    ]);
  }
  assert.equal(socket.destroyed, true);
});

test("stop closes clients and every network service and is idempotent", async (t) => {
  const fixture = await createFixtureFiles();
  const server = createValueArchiveServer({
    registryFilePath: fixture.registryFilePath,
    sequenceFilePath: fixture.sequenceFilePath,
    httpHost: "127.0.0.1",
    httpPort: 0,
    udpHost: "127.0.0.1",
    udpPort: 0,
    pingIntervalMs: 20,
    deviceUpdateIntervalMs: 20,
    offlineTimeoutMs: 50,
    logger: { info() {}, warn() {}, error() {}, log() {} }
  });

  t.after(async () => {
    await server.stop();
    await rm(fixture.directory, { recursive: true, force: true });
  });

  assert.equal(server.address(), null);
  await server.stop();

  const starting = server.start();
  const stoppingDuringStart = server.stop();
  await Promise.all([starting, stoppingDuringStart]);
  assert.equal(server.address(), null);

  const firstStarting = server.start();
  const stoppingAgain = server.stop();
  const restarting = server.start();
  await Promise.all([firstStarting, stoppingAgain, restarting]);
  assert.notEqual(server.address(), null);

  const runningAddress = server.address();
  const peer = await openPeer(
    t,
    `ws://127.0.0.1:${runningAddress.http.port}/ws`
  );
  peer.sendJson({ t: "hello", clientType: "dashboard" });
  await peer.nextJson("welcome");

  await server.stop();
  await waitForPeerClose(peer);
  assert.equal(server.address(), null);
  await server.stop();

  await assert.rejects(
    fetch(`http://127.0.0.1:${runningAddress.http.port}/api/state`)
  );
});
