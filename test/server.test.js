import assert from "node:assert/strict";
import dgram from "node:dgram";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import WebSocket from "ws";

import {
  createValueArchiveServer,
  isIpv4InSubnet,
  resolveHttpPort,
  selectAdvertiseIp
} from "../src/server.js";

const sequenceFixture = {
  sequenceId: "performance-v1",
  music: [
    {
      trackId: "amb_1_2",
      label: "엠비언스 (amb_1.2)",
      file: "amb_1.2.mp3"
    },
    {
      trackId: "mus_2_1",
      label: "흥미로운 음악 (mus_2.1)",
      file: "mus_2.1.mp3"
    },
    {
      trackId: "mus_reunion",
      label: "추억속의 재회",
      file: "mus_추억속의재회.mp3"
    }
  ],
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

const initialMusicState = {
  tracks: [
    {
      trackId: "amb_1_2",
      label: "엠비언스 (amb_1.2)",
      file: "amb_1.2.mp3",
      playing: false,
      startedAtServerMs: null,
      fadeOutSeconds: 0
    },
    {
      trackId: "mus_2_1",
      label: "흥미로운 음악 (mus_2.1)",
      file: "mus_2.1.mp3",
      playing: false,
      startedAtServerMs: null,
      fadeOutSeconds: 0
    },
    {
      trackId: "mus_reunion",
      label: "추억속의 재회",
      file: "mus_추억속의재회.mp3",
      playing: false,
      startedAtServerMs: null,
      fadeOutSeconds: 0
    }
  ]
};

const initialSubtitleState = {
  lang: "zh"
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

async function findAvailableTcpPort() {
  const server = createTcpServer();

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return server.address().port;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withVaPort(value, callback) {
  const hadValue = Object.hasOwn(process.env, "VA_PORT");
  const previousValue = process.env.VA_PORT;

  if (value === undefined) {
    delete process.env.VA_PORT;
  } else {
    process.env.VA_PORT = value;
  }

  try {
    return await callback();
  } finally {
    if (hadValue) {
      process.env.VA_PORT = previousValue;
    } else {
      delete process.env.VA_PORT;
    }
  }
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

function musicTrackFrom(message, trackId) {
  return message.tracks.find((track) => track.trackId === trackId);
}

function sequenceWithMusicCues(...musicCues) {
  const sequence = structuredClone(sequenceFixture);
  for (const [stepIndex, musicCue] of musicCues.entries()) {
    sequence.steps[stepIndex].params.musicCue = musicCue;
  }
  return sequence;
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

test("isIpv4InSubnet matches IPv4 subnet boundaries", () => {
  const interfaceAddress = "192.168.50.114";
  const netmask = "255.255.255.0";

  assert.equal(
    isIpv4InSubnet("192.168.50.42", interfaceAddress, netmask),
    true
  );
  assert.equal(
    isIpv4InSubnet("192.168.51.42", interfaceAddress, netmask),
    false
  );
  assert.equal(
    isIpv4InSubnet("192.168.50.0", interfaceAddress, netmask),
    true
  );
  assert.equal(
    isIpv4InSubnet("192.168.50.255", interfaceAddress, netmask),
    true
  );
  assert.equal(
    isIpv4InSubnet(
      "100.71.101.118",
      "100.71.101.118",
      "255.255.255.255"
    ),
    true
  );
  assert.equal(
    isIpv4InSubnet(
      "100.71.101.119",
      "100.71.101.118",
      "255.255.255.255"
    ),
    false
  );
});

test("isIpv4InSubnet rejects malformed, IPv6, and non-string inputs", () => {
  const validAddress = "192.168.50.114";
  const validMask = "255.255.255.0";
  const cases = [
    ["not-an-ip", validAddress, validMask],
    [validAddress, "not-an-ip", validMask],
    [validAddress, validAddress, "not-a-mask"],
    ["2001:db8::1", validAddress, validMask],
    [validAddress, "2001:db8::1", validMask],
    [validAddress, validAddress, "ffff:ffff:ffff:ffff::"],
    [42, validAddress, validMask],
    [validAddress, null, validMask],
    [validAddress, validAddress, {}]
  ];

  for (const args of cases) {
    assert.equal(isIpv4InSubnet(...args), false);
  }
});

test("selectAdvertiseIp prioritizes override, requester subnet, and fallbacks", () => {
  const candidates = [
    {
      address: "100.71.101.118",
      netmask: "255.255.255.255",
      cidr: "100.71.101.118/32"
    },
    {
      address: "192.168.50.114",
      netmask: "255.255.255.0",
      cidr: "192.168.50.114/24"
    }
  ];

  assert.equal(
    selectAdvertiseIp({
      configuredAdvertiseIp: "203.0.113.10",
      requesterAddress: "192.168.50.42",
      candidates
    }),
    "203.0.113.10"
  );
  assert.equal(
    selectAdvertiseIp({
      requesterAddress: "192.168.50.42",
      candidates
    }),
    "192.168.50.114"
  );
  assert.equal(
    selectAdvertiseIp({
      requesterAddress: "198.51.100.23",
      candidates
    }),
    "100.71.101.118"
  );
  assert.equal(
    selectAdvertiseIp({
      requesterAddress: "198.51.100.23",
      candidates: []
    }),
    "127.0.0.1"
  );
});

test("resolves TCP port 17800 when no HTTP port option or VA_PORT is set", async () => {
  await withVaPort(undefined, async () => {
    assert.equal(
      resolveHttpPort({
        httpPort: undefined,
        port: undefined
      }),
      17800
    );
  });
});

test("uses VA_PORT when neither explicit HTTP port option is set", async (t) => {
  const selectedPort = await findAvailableTcpPort();

  await withVaPort(String(selectedPort), async () => {
    const fixture = await createRunningServer(t, {}, {
      httpPort: undefined,
      port: undefined
    });

    assert.equal(fixture.addresses.http.port, selectedPort);
  });
});

test("explicit HTTP port options take precedence over VA_PORT and preserve zero", async (t) => {
  await withVaPort("not-a-port", async () => {
    const explicitHttpPort = await createRunningServer(t, {}, {
      httpPort: 0,
      port: 1
    });
    assert.notEqual(explicitHttpPort.addresses.http.port, 0);
    assert.notEqual(explicitHttpPort.addresses.http.port, 1);

    const explicitPortAlias = await createRunningServer(t, {}, {
      httpPort: undefined,
      port: 0
    });
    assert.notEqual(explicitPortAlias.addresses.http.port, 0);
  });
});

test("rejects invalid VA_PORT decimal strings and ranges", async () => {
  for (const value of [
    "",
    "0",
    "65536",
    "-1",
    "1.5",
    "17800junk",
    " 17800",
    "0x223d"
  ]) {
    await withVaPort(value, async () => {
      assert.throws(
        () =>
          createValueArchiveServer({
            httpPort: undefined,
            port: undefined,
            advertiseIp: "192.0.2.44"
          }),
        {
          name: "TypeError",
          message: /VA_PORT must be a decimal integer from 1 through 65535/
        }
      );
    });
  }
});

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
    "sequence",
    "musicState",
    "subtitleState"
  ]);
  assert.deepEqual(initial.json.devices, []);
  assert.deepEqual(initial.json.sequence, sequenceFixture);
  assert.deepEqual(initial.json.musicState, initialMusicState);
  assert.deepEqual(initial.json.subtitleState, initialSubtitleState);
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
  stateCopy.musicState.tracks[0].playing = true;
  stateCopy.subtitleState.lang = "en";
  assert.equal(fixture.server.getState().sequence.steps[0].title, "Intro");
  assert.equal(fixture.server.getState().seqState.params.cue, "standby");
  assert.equal(
    fixture.server.getState().musicState.tracks[0].playing,
    false
  );
  assert.deepEqual(
    fixture.server.getState().subtitleState,
    initialSubtitleState
  );

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

  const advanced = await requestJson(`${fixture.httpBaseUrl}/api/seq`, {
    method: "POST",
    body: { action: "next" }
  });
  assert.equal(advanced.response.status, 200);
  assert.equal(advanced.json.seqState.running, true);
  assert.equal(advanced.json.seqState.stepIndex, 1);

  const playingMusic = await requestJson(
    `${fixture.httpBaseUrl}/api/music`,
    {
      method: "POST",
      body: { trackId: "amb_1_2", action: "play" }
    }
  );
  assert.equal(playingMusic.response.status, 200);
  assert.equal(playingMusic.json.musicState.tracks[0].playing, true);

  const english = await requestJson(
    `${fixture.httpBaseUrl}/api/subtitle`,
    {
      method: "POST",
      body: { lang: "en" }
    }
  );
  assert.equal(english.response.status, 200);
  assert.equal(english.json.subtitleState.lang, "en");

  const reset = await requestJson(`${fixture.httpBaseUrl}/api/seq`, {
    method: "POST",
    body: { action: "reset" }
  });
  assert.equal(reset.response.status, 200);
  assert.equal(reset.json.ok, true);
  assert.equal(reset.json.seqState.running, false);
  assert.equal(reset.json.seqState.stepIndex, 0);

  const current = await requestJson(`${fixture.httpBaseUrl}/api/state`);
  assert.equal(current.json.seqState.running, false);
  assert.equal(current.json.seqState.stepIndex, 0);
  assert.deepEqual(current.json.musicState, initialMusicState);
  assert.deepEqual(current.json.subtitleState, initialSubtitleState);
});

test("POST /api/music returns and broadcasts state and rejects invalid commands", async (t) => {
  const fixture = await createRunningServer(t, {}, {
    now: () => 5_000
  });
  const dashboard = await openPeer(t, fixture.wsUrl);
  const quest = await openPeer(t, fixture.wsUrl);
  const unwelcomed = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  quest.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-rest-music"
  });
  await Promise.all([
    dashboard.nextJson("welcome"),
    quest.nextJson("welcome")
  ]);

  const response = await fetch(`${fixture.httpBaseUrl}/api/music`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trackId: "mus_2_1", action: "play" })
  });
  assert.equal(response.status, 200);
  const json = await response.json();
  const expectedMusicState = {
    tracks: [
      {
        trackId: "amb_1_2",
        label: "엠비언스 (amb_1.2)",
        file: "amb_1.2.mp3",
        playing: false,
        startedAtServerMs: null,
        fadeOutSeconds: 0
      },
      {
        trackId: "mus_2_1",
        label: "흥미로운 음악 (mus_2.1)",
        file: "mus_2.1.mp3",
        playing: true,
        startedAtServerMs: 5_000,
        fadeOutSeconds: 0
      },
      {
        trackId: "mus_reunion",
        label: "추억속의 재회",
        file: "mus_추억속의재회.mp3",
        playing: false,
        startedAtServerMs: null,
        fadeOutSeconds: 0
      }
    ]
  };
  assert.deepEqual(json, { ok: true, musicState: expectedMusicState });
  const [dashboardState, questState] = await Promise.all([
    dashboard.nextJson("musicState"),
    quest.nextJson("musicState")
  ]);
  assert.deepEqual(dashboardState, { t: "musicState", ...expectedMusicState });
  assert.deepEqual(questState, { t: "musicState", ...expectedMusicState });
  await assert.rejects(
    unwelcomed.nextJson("musicState", () => true, 80),
    /Timed out waiting for JSON message musicState/
  );

  for (const body of [
    { trackId: "not-in-sequence", action: "play" },
    { trackId: "amb_1_2", action: "resume" }
  ]) {
    const invalid = await requestJson(`${fixture.httpBaseUrl}/api/music`, {
      method: "POST",
      body
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.json.ok, false);
    assert.equal(invalid.json.error?.code, "INVALID_MUSIC_COMMAND");
    assert.equal(typeof invalid.json.error?.message, "string");
  }
  assert.deepEqual(fixture.server.getState().musicState, expectedMusicState);
  await assert.rejects(
    dashboard.nextJson("musicState", () => true, 80),
    /Timed out waiting for JSON message musicState/
  );
});

test("POST /api/subtitle selects and broadcasts absolute languages", async (t) => {
  const fixture = await createRunningServer(t);
  const dashboard = await openPeer(t, fixture.wsUrl);
  const quest = await openPeer(t, fixture.wsUrl);
  const unwelcomed = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  quest.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-rest-subtitle"
  });
  await Promise.all([
    dashboard.nextJson("welcome"),
    quest.nextJson("welcome")
  ]);

  const response = await requestJson(
    `${fixture.httpBaseUrl}/api/subtitle`,
    {
      method: "POST",
      body: { lang: "zh" }
    }
  );
  assert.equal(response.response.status, 200);
  assert.deepEqual(response.json, {
    ok: true,
    subtitleState: { lang: "zh" }
  });

  const [dashboardState, questState] = await Promise.all([
    dashboard.nextJson("subtitleState"),
    quest.nextJson("subtitleState")
  ]);
  const expectedMessage = {
    t: "subtitleState",
    lang: "zh"
  };
  assert.deepEqual(dashboardState, expectedMessage);
  assert.deepEqual(questState, expectedMessage);
  await assert.rejects(
    unwelcomed.nextJson("subtitleState", () => true, 80),
    /Timed out waiting for JSON message subtitleState/
  );

  const reselected = await requestJson(
    `${fixture.httpBaseUrl}/api/subtitle`,
    {
      method: "POST",
      body: { lang: "zh" }
    }
  );
  assert.equal(reselected.response.status, 200);
  assert.deepEqual(reselected.json, {
    ok: true,
    subtitleState: { lang: "zh" }
  });
  const [dashboardReselected, questReselected] = await Promise.all([
    dashboard.nextJson("subtitleState"),
    quest.nextJson("subtitleState")
  ]);
  assert.deepEqual(dashboardReselected, expectedMessage);
  assert.deepEqual(questReselected, expectedMessage);

  for (const body of [
    { lang: "fr" },
    { lang: "" },
    {}
  ]) {
    const invalid = await requestJson(
      `${fixture.httpBaseUrl}/api/subtitle`,
      { method: "POST", body }
    );
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.json.ok, false);
    assert.equal(
      invalid.json.error?.code,
      "INVALID_SUBTITLE_COMMAND"
    );
    assert.equal(typeof invalid.json.error?.message, "string");
  }
  assert.deepEqual(fixture.server.getState().subtitleState, {
    lang: "zh"
  });
  await assert.rejects(
    dashboard.nextJson("subtitleState", () => true, 80),
    /Timed out waiting for JSON message subtitleState/
  );
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
    "sequence",
    "musicState",
    "subtitleState"
  ]);
  assert.deepEqual(dashboardWelcome.devices, []);
  assert.deepEqual(dashboardWelcome.sequence, sequenceFixture);
  assert.deepEqual(dashboardWelcome.musicState, initialMusicState);
  assert.deepEqual(dashboardWelcome.subtitleState, initialSubtitleState);

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
    "seqState",
    "musicState",
    "subtitleState"
  ]);
  assert.equal(questWelcome.role, "A");
  assert.equal(typeof questWelcome.serverTimeMs, "number");
  assert.equal(questWelcome.seqState.stepId, "intro");
  assert.deepEqual(questWelcome.musicState, initialMusicState);
  assert.deepEqual(questWelcome.subtitleState, initialSubtitleState);
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

test("dashboard music commands broadcast play, replay, and stop state to every welcomed client", async (t) => {
  let nowMs = 1_000;
  const fixture = await createRunningServer(t, {}, {
    now: () => nowMs
  });
  const dashboard = await openPeer(t, fixture.wsUrl);
  const quest = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  quest.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-music"
  });
  await Promise.all([
    dashboard.nextJson("welcome"),
    quest.nextJson("welcome")
  ]);

  const expectedPlayingState = {
    t: "musicState",
    tracks: [
      {
        trackId: "amb_1_2",
        label: "엠비언스 (amb_1.2)",
        file: "amb_1.2.mp3",
        playing: true,
        startedAtServerMs: 1_000,
        fadeOutSeconds: 0
      },
      {
        trackId: "mus_2_1",
        label: "흥미로운 음악 (mus_2.1)",
        file: "mus_2.1.mp3",
        playing: false,
        startedAtServerMs: null,
        fadeOutSeconds: 0
      },
      {
        trackId: "mus_reunion",
        label: "추억속의 재회",
        file: "mus_추억속의재회.mp3",
        playing: false,
        startedAtServerMs: null,
        fadeOutSeconds: 0
      }
    ]
  };

  dashboard.sendJson({
    t: "musicCommand",
    trackId: "amb_1_2",
    action: "play"
  });
  const [dashboardPlay, questPlay] = await Promise.all([
    dashboard.nextJson(
      "musicState",
      (message) => musicTrackFrom(message, "amb_1_2")?.playing === true
    ),
    quest.nextJson(
      "musicState",
      (message) => musicTrackFrom(message, "amb_1_2")?.playing === true
    )
  ]);
  assert.deepEqual(dashboardPlay, expectedPlayingState);
  assert.deepEqual(questPlay, expectedPlayingState);
  assert.ok(
    fixture.logs.some(
      ({ message }) =>
        message.startsWith("[VA]") &&
        /\bmusic\b/i.test(message) &&
        message.includes('trackId="amb_1_2"') &&
        message.includes('action="play"')
    ),
    "a valid music command must be logged with sanitized values"
  );

  nowMs = 2_000;
  dashboard.sendJson({
    t: "musicCommand",
    trackId: "amb_1_2",
    action: "play"
  });
  const [dashboardReplay, questReplay] = await Promise.all([
    dashboard.nextJson("musicState"),
    quest.nextJson("musicState")
  ]);
  assert.deepEqual(dashboardReplay, expectedPlayingState);
  assert.deepEqual(questReplay, expectedPlayingState);

  nowMs = 3_000;
  dashboard.sendJson({
    t: "musicCommand",
    trackId: "amb_1_2",
    action: "stop"
  });
  const [dashboardStop, questStop] = await Promise.all([
    dashboard.nextJson(
      "musicState",
      (message) => musicTrackFrom(message, "amb_1_2")?.playing === false
    ),
    quest.nextJson(
      "musicState",
      (message) => musicTrackFrom(message, "amb_1_2")?.playing === false
    )
  ]);
  assert.deepEqual(dashboardStop, { t: "musicState", ...initialMusicState });
  assert.deepEqual(questStop, { t: "musicState", ...initialMusicState });

  for (const command of [
    { t: "musicCommand", trackId: "missing-track", action: "play" },
    { t: "musicCommand", trackId: "amb_1_2", action: "pause" }
  ]) {
    dashboard.sendJson(command);
    const error = await dashboard.nextJson("error");
    assert.deepEqual(Object.keys(error), ["t", "code", "message"]);
    assert.equal(error.code, "INVALID_MUSIC_COMMAND");
    assert.equal(typeof error.message, "string");
  }
  assert.deepEqual(fixture.server.getState().musicState, initialMusicState);
  await assert.rejects(
    dashboard.nextJson("musicState", () => true, 80),
    /Timed out waiting for JSON message musicState/
  );
});

test("dashboard subtitle commands select languages and reject invalid payloads", async (t) => {
  const fixture = await createRunningServer(t);
  const dashboard = await openPeer(t, fixture.wsUrl);
  const quest = await openPeer(t, fixture.wsUrl);
  const unwelcomed = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  quest.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-subtitle"
  });
  const [dashboardWelcome, questWelcome] = await Promise.all([
    dashboard.nextJson("welcome"),
    quest.nextJson("welcome")
  ]);
  assert.deepEqual(dashboardWelcome.subtitleState, initialSubtitleState);
  assert.deepEqual(questWelcome.subtitleState, initialSubtitleState);

  dashboard.sendJson({
    t: "subtitleCommand",
    lang: "en"
  });
  const [dashboardEnglish, questEnglish] = await Promise.all([
    dashboard.nextJson("subtitleState"),
    quest.nextJson("subtitleState")
  ]);
  const englishState = {
    t: "subtitleState",
    lang: "en"
  };
  assert.deepEqual(dashboardEnglish, englishState);
  assert.deepEqual(questEnglish, englishState);

  dashboard.sendJson({
    t: "subtitleCommand",
    lang: "zh"
  });
  const [dashboardMandarin, questMandarin] = await Promise.all([
    dashboard.nextJson("subtitleState"),
    quest.nextJson("subtitleState")
  ]);
  const mandarinState = {
    t: "subtitleState",
    lang: "zh"
  };
  assert.deepEqual(dashboardMandarin, mandarinState);
  assert.deepEqual(questMandarin, mandarinState);

  dashboard.sendJson({
    t: "subtitleCommand",
    lang: "kr"
  });
  const [dashboardKorean, questKorean] = await Promise.all([
    dashboard.nextJson("subtitleState"),
    quest.nextJson("subtitleState")
  ]);
  const koreanState = {
    t: "subtitleState",
    lang: "kr"
  };
  assert.deepEqual(dashboardKorean, koreanState);
  assert.deepEqual(questKorean, koreanState);
  await assert.rejects(
    unwelcomed.nextJson("subtitleState", () => true, 80),
    /Timed out waiting for JSON message subtitleState/
  );

  for (const command of [
    { t: "subtitleCommand", lang: "fr" },
    { t: "subtitleCommand", lang: null },
    { t: "subtitleCommand" }
  ]) {
    dashboard.sendJson(command);
    const error = await dashboard.nextJson("error");
    assert.deepEqual(Object.keys(error), ["t", "code", "message"]);
    assert.equal(error.code, "INVALID_SUBTITLE_COMMAND");
    assert.equal(typeof error.message, "string");
  }
  assert.deepEqual(fixture.server.getState().subtitleState, {
    lang: "kr"
  });
  await assert.rejects(
    dashboard.nextJson("subtitleState", () => true, 80),
    /Timed out waiting for JSON message subtitleState/
  );
});

test("stop and start reset all runtime music and subtitle state", async (t) => {
  let nowMs = 7_000;
  const fixture = await createRunningServer(t, {}, {
    now: () => nowMs
  });
  const dashboard = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  await dashboard.nextJson("welcome");

  dashboard.sendJson({
    t: "musicCommand",
    trackId: "mus_reunion",
    action: "play"
  });
  const playing = await dashboard.nextJson(
    "musicState",
    (message) => musicTrackFrom(message, "mus_reunion")?.playing === true
  );
  assert.equal(
    musicTrackFrom(playing, "mus_reunion").startedAtServerMs,
    7_000
  );

  dashboard.sendJson({
    t: "subtitleCommand",
    lang: "en"
  });
  assert.deepEqual(await dashboard.nextJson("subtitleState"), {
    t: "subtitleState",
    lang: "en"
  });

  await fixture.server.stop();
  nowMs = 8_000;
  await fixture.server.start();
  assert.deepEqual(fixture.server.getState().musicState, initialMusicState);
  assert.deepEqual(
    fixture.server.getState().subtitleState,
    initialSubtitleState
  );
});

test("assigned Quests relay valid voFinished events to dashboards only", async (t) => {
  let nowMs = 9_000;
  const fixture = await createRunningServer(
    t,
    { assignments: { "quest-vo": "B" } },
    { now: () => nowMs }
  );
  const dashboard = await openPeer(t, fixture.wsUrl);
  const assignedQuest = await openPeer(t, fixture.wsUrl);
  const rolelessQuest = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  assignedQuest.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-vo"
  });
  rolelessQuest.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-no-role"
  });
  await Promise.all([
    dashboard.nextJson("welcome"),
    assignedQuest.nextJson("welcome"),
    rolelessQuest.nextJson("welcome")
  ]);

  nowMs = 9_100;
  assignedQuest.sendJson({ t: "voFinished", stepId: "approach" });
  assert.deepEqual(await dashboard.nextJson("voStatus"), {
    t: "voStatus",
    stepId: "approach",
    role: "B",
    finishedAtServerMs: 9_100
  });
  await assert.rejects(
    assignedQuest.nextJson("voStatus", () => true, 80),
    /Timed out waiting for JSON message voStatus/
  );
  await assert.rejects(
    rolelessQuest.nextJson("voStatus", () => true, 80),
    /Timed out waiting for JSON message voStatus/
  );

  assignedQuest.sendJson({ t: "voFinished", stepId: "   " });
  await assert.rejects(
    dashboard.nextJson("voStatus", () => true, 80),
    /Timed out waiting for JSON message voStatus/
  );

  rolelessQuest.sendJson({ t: "voFinished", stepId: "intro" });
  await assert.rejects(
    dashboard.nextJson("voStatus", () => true, 80),
    /Timed out waiting for JSON message voStatus/
  );
});

test("normalizes negative Quest health sentinels before storing and forwarding", async (t) => {
  const fixture = await createRunningServer(t);
  const dashboard = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  await dashboard.nextJson("welcome");

  const quest = await openPeer(t, fixture.wsUrl);
  quest.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-negative-sentinels"
  });
  await quest.nextJson("welcome");

  quest.sendJson({
    t: "health",
    fps: 71.9,
    cvHz: 0,
    cvMs: 0.4,
    batteryPct: -1,
    markers: [],
    dist: {
      markerToMarker: -1,
      selfToOwn: -1,
      selfToOther: -1
    },
    trackingOk: false
  });

  const expectedHealth = {
    fps: 71.9,
    cvHz: 0,
    cvMs: 0.4,
    batteryPct: null,
    markers: [],
    dist: {
      markerToMarker: null,
      selfToOwn: null,
      selfToOther: null
    },
    trackingOk: false
  };
  const forwardedUpdate = await dashboard.nextJson(
    "deviceUpdate",
    (message) =>
      deviceFrom(message, "quest-negative-sentinels")?.lastHealth?.fps ===
      71.9
  );
  const forwardedHealth = deviceFrom(
    forwardedUpdate,
    "quest-negative-sentinels"
  ).lastHealth;
  const storedHealth = deviceFrom(
    fixture.server.getState(),
    "quest-negative-sentinels"
  ).lastHealth;

  assert.deepEqual(forwardedHealth, expectedHealth);
  assert.deepEqual(storedHealth, expectedHealth);
  for (const health of [forwardedHealth, storedHealth]) {
    assert.equal(health.batteryPct, null);
    assert.deepEqual(Object.values(health.dist), [null, null, null]);
    assert.equal(
      [health.batteryPct, ...Object.values(health.dist)].some(
        (value) => typeof value === "number" && value < 0
      ),
      false
    );
  }
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

test("dashboard reset restores show state and broadcasts sequence, music, and subtitles", async (t) => {
  const fixture = await createRunningServer(t, {}, {
    now: () => 17_000
  });
  const dashboard = await openPeer(t, fixture.wsUrl);
  const quest = await openPeer(t, fixture.wsUrl);
  const unwelcomed = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  quest.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-reset"
  });
  await Promise.all([
    dashboard.nextJson("welcome"),
    quest.nextJson("welcome")
  ]);

  dashboard.sendJson({ t: "seqCommand", action: "start" });
  await Promise.all([
    dashboard.nextJson("seqState", (message) => message.running === true),
    quest.nextJson("seqState", (message) => message.running === true)
  ]);
  dashboard.sendJson({ t: "seqCommand", action: "next" });
  await Promise.all([
    dashboard.nextJson("seqState", (message) => message.stepIndex === 1),
    quest.nextJson("seqState", (message) => message.stepIndex === 1)
  ]);

  for (const trackId of ["amb_1_2", "mus_2_1"]) {
    dashboard.sendJson({ t: "musicCommand", trackId, action: "play" });
    await Promise.all([
      dashboard.nextJson(
        "musicState",
        (message) => musicTrackFrom(message, trackId)?.playing === true
      ),
      quest.nextJson(
        "musicState",
        (message) => musicTrackFrom(message, trackId)?.playing === true
      )
    ]);
  }
  dashboard.sendJson({ t: "subtitleCommand", lang: "en" });
  await Promise.all([
    dashboard.nextJson(
      "subtitleState",
      (message) => message.lang === "en"
    ),
    quest.nextJson("subtitleState", (message) => message.lang === "en")
  ]);

  dashboard.sendJson({ t: "seqCommand", action: "reset" });
  const resetStateTypes = new Set([
    "seqState",
    "musicState",
    "subtitleState"
  ]);
  async function nextResetStates(peer) {
    const messages = [];
    while (messages.length < resetStateTypes.size) {
      const item = await peer.next(
        (candidate) =>
          !candidate.isBinary &&
          resetStateTypes.has(candidate.json?.t),
        "ordered reset state message"
      );
      messages.push(item.json);
    }
    return messages;
  }
  const [dashboardStates, questStates] = await Promise.all([
    nextResetStates(dashboard),
    nextResetStates(quest)
  ]);
  assert.deepEqual(
    dashboardStates.map((message) => message.t),
    ["seqState", "musicState", "subtitleState"]
  );
  assert.deepEqual(
    questStates.map((message) => message.t),
    ["seqState", "musicState", "subtitleState"]
  );
  const [dashboardSeq, dashboardMusic, dashboardSubtitle] =
    dashboardStates;
  const [questSeq, questMusic, questSubtitle] = questStates;

  for (const seqState of [dashboardSeq, questSeq]) {
    assert.equal(seqState.running, false);
    assert.equal(seqState.stepIndex, 0);
  }
  for (const musicState of [dashboardMusic, questMusic]) {
    assert.ok(musicState.tracks.every((track) => !track.playing));
    assert.ok(
      musicState.tracks.every(
        (track) => track.startedAtServerMs === null
      )
    );
  }
  assert.deepEqual(dashboardSubtitle, { t: "subtitleState", lang: "zh" });
  assert.deepEqual(questSubtitle, { t: "subtitleState", lang: "zh" });
  assert.deepEqual(fixture.server.getState().seqState, {
    sequenceId: "performance-v1",
    running: false,
    stepIndex: 0,
    stepId: "intro",
    enteredAtServerMs: 17_000,
    params: { cue: "standby" }
  });
  assert.deepEqual(fixture.server.getState().musicState, initialMusicState);
  assert.deepEqual(
    fixture.server.getState().subtitleState,
    initialSubtitleState
  );

  for (const type of ["seqState", "musicState", "subtitleState"]) {
    await assert.rejects(
      unwelcomed.nextJson(type, () => true, 80),
      new RegExp(`Timed out waiting for JSON message ${type}`)
    );
  }
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

test("entering a sequence step with an in music cue starts and broadcasts the track", async (t) => {
  const fixture = await createRunningServer(
    t,
    {
      sequence: sequenceWithMusicCues({
        trackId: "amb_1_2",
        action: "in"
      })
    },
    { now: () => 12_000 }
  );
  const dashboard = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  await dashboard.nextJson("welcome");

  dashboard.sendJson({ t: "seqCommand", action: "start" });
  const [seqState, musicState] = await Promise.all([
    dashboard.nextJson("seqState", (message) => message.running === true),
    dashboard.nextJson(
      "musicState",
      (message) => musicTrackFrom(message, "amb_1_2")?.playing === true
    )
  ]);

  assert.equal(seqState.stepId, "intro");
  assert.deepEqual(musicTrackFrom(musicState, "amb_1_2"), {
    trackId: "amb_1_2",
    label: "엠비언스 (amb_1.2)",
    file: "amb_1.2.mp3",
    playing: true,
    startedAtServerMs: 12_000,
    fadeOutSeconds: 0
  });
});

test("entering a sequence step with an out music cue stops and broadcasts the track", async (t) => {
  let nowMs = 13_000;
  const fixture = await createRunningServer(
    t,
    {
      sequence: sequenceWithMusicCues(
        { trackId: "amb_1_2", action: "in" },
        { trackId: "amb_1_2", action: "out" }
      )
    },
    { now: () => nowMs }
  );
  const dashboard = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  await dashboard.nextJson("welcome");

  dashboard.sendJson({ t: "seqCommand", action: "start" });
  await Promise.all([
    dashboard.nextJson("seqState", (message) => message.running === true),
    dashboard.nextJson(
      "musicState",
      (message) => musicTrackFrom(message, "amb_1_2")?.playing === true
    )
  ]);

  nowMs = 14_000;
  dashboard.sendJson({ t: "seqCommand", action: "next" });
  const [seqState, musicState] = await Promise.all([
    dashboard.nextJson("seqState", (message) => message.stepIndex === 1),
    dashboard.nextJson(
      "musicState",
      (message) => musicTrackFrom(message, "amb_1_2")?.playing === false
    )
  ]);

  assert.equal(seqState.stepId, "approach");
  assert.deepEqual(musicTrackFrom(musicState, "amb_1_2"), {
    trackId: "amb_1_2",
    label: "엠비언스 (amb_1.2)",
    file: "amb_1.2.mp3",
    playing: false,
    startedAtServerMs: null,
    fadeOutSeconds: 0
  });
});

test("stopping the sequence stops all playing music tracks", async (t) => {
  const fixture = await createRunningServer(t);
  const dashboard = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  await dashboard.nextJson("welcome");

  for (const trackId of ["amb_1_2", "mus_2_1"]) {
    dashboard.sendJson({ t: "musicCommand", trackId, action: "play" });
    await dashboard.nextJson(
      "musicState",
      (message) => musicTrackFrom(message, trackId)?.playing === true
    );
  }

  dashboard.sendJson({ t: "seqCommand", action: "stop" });
  const [seqState, musicState] = await Promise.all([
    dashboard.nextJson("seqState", (message) => message.running === false),
    dashboard.nextJson(
      "musicState",
      (message) => message.tracks.every((track) => !track.playing)
    )
  ]);

  assert.equal(seqState.running, false);
  assert.ok(musicState.tracks.every((track) => !track.playing));
  assert.ok(
    musicState.tracks.every((track) => track.startedAtServerMs === null)
  );
});

test("an unknown music cue track warns without blocking the sequence transition", async (t) => {
  const fixture = await createRunningServer(t, {
    sequence: sequenceWithMusicCues({
      trackId: "missing-track",
      action: "in"
    })
  });
  const dashboard = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  await dashboard.nextJson("welcome");

  dashboard.sendJson({ t: "seqCommand", action: "start" });
  const seqState = await dashboard.nextJson(
    "seqState",
    (message) => message.running === true
  );

  assert.equal(seqState.stepId, "intro");
  assert.ok(
    fixture.logs.some(
      ({ level, message }) =>
        level === "warn" &&
        message.includes('trackId="missing-track"')
    )
  );
});

test("voEnd music cues wait for matching voFinished from a roleless Quest", async (t) => {
  const fixture = await createRunningServer(
    t,
    {
      sequence: sequenceWithMusicCues({
        trackId: "amb_1_2",
        action: "in",
        timing: "voEnd"
      })
    },
    { now: () => 15_000 }
  );
  const dashboard = await openPeer(t, fixture.wsUrl);
  const quest = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  quest.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-roleless-vo"
  });
  await Promise.all([
    dashboard.nextJson("welcome"),
    quest.nextJson("welcome")
  ]);

  dashboard.sendJson({ t: "seqCommand", action: "start" });
  await dashboard.nextJson(
    "seqState",
    (message) => message.running === true
  );
  await assert.rejects(
    dashboard.nextJson("musicState", () => true, 80),
    /Timed out waiting for JSON message musicState/
  );
  assert.equal(
    musicTrackFrom(fixture.server.getState().musicState, "amb_1_2").playing,
    false
  );

  quest.sendJson({ t: "voFinished", stepId: "intro" });
  const musicState = await dashboard.nextJson(
    "musicState",
    (message) => musicTrackFrom(message, "amb_1_2")?.playing === true
  );
  assert.deepEqual(musicTrackFrom(musicState, "amb_1_2"), {
    trackId: "amb_1_2",
    label: "엠비언스 (amb_1.2)",
    file: "amb_1.2.mp3",
    playing: true,
    startedAtServerMs: 15_000,
    fadeOutSeconds: 0
  });
  await assert.rejects(
    dashboard.nextJson("voStatus", () => true, 80),
    /Timed out waiting for JSON message voStatus/
  );
});

test("a second Quest cannot execute the same pending voEnd cue twice", async (t) => {
  const fixture = await createRunningServer(t, {
    assignments: { "quest-vo-a": "A", "quest-vo-b": "B" },
    sequence: sequenceWithMusicCues({
      trackId: "amb_1_2",
      action: "in",
      timing: "voEnd"
    })
  });
  const dashboard = await openPeer(t, fixture.wsUrl);
  const questA = await openPeer(t, fixture.wsUrl);
  const questB = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  questA.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-vo-a"
  });
  questB.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-vo-b"
  });
  await Promise.all([
    dashboard.nextJson("welcome"),
    questA.nextJson("welcome"),
    questB.nextJson("welcome")
  ]);

  dashboard.sendJson({ t: "seqCommand", action: "start" });
  await dashboard.nextJson(
    "seqState",
    (message) => message.running === true
  );
  await assert.rejects(
    dashboard.nextJson("musicState", () => true, 40),
    /Timed out waiting for JSON message musicState/
  );

  questA.sendJson({ t: "voFinished", stepId: "intro" });
  await Promise.all([
    dashboard.nextJson(
      "musicState",
      (message) => musicTrackFrom(message, "amb_1_2")?.playing === true
    ),
    dashboard.nextJson("voStatus", (message) => message.role === "A")
  ]);

  questB.sendJson({ t: "voFinished", stepId: "intro" });
  await dashboard.nextJson("voStatus", (message) => message.role === "B");
  await assert.rejects(
    dashboard.nextJson("musicState", () => true, 80),
    /Timed out waiting for JSON message musicState/
  );
});

test("stale voFinished leaves the current step's pending voEnd cue untouched", async (t) => {
  const fixture = await createRunningServer(t, {
    sequence: sequenceWithMusicCues(null, {
      trackId: "amb_1_2",
      action: "in",
      timing: "voEnd"
    })
  });
  const dashboard = await openPeer(t, fixture.wsUrl);
  const quest = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  quest.sendJson({
    t: "hello",
    clientType: "quest",
    deviceId: "quest-stale-vo"
  });
  await Promise.all([
    dashboard.nextJson("welcome"),
    quest.nextJson("welcome")
  ]);

  dashboard.sendJson({ t: "seqCommand", action: "start" });
  await dashboard.nextJson(
    "seqState",
    (message) => message.running === true
  );
  dashboard.sendJson({ t: "seqCommand", action: "next" });
  await dashboard.nextJson(
    "seqState",
    (message) => message.stepId === "approach"
  );

  quest.sendJson({ t: "voFinished", stepId: "intro" });
  await assert.rejects(
    dashboard.nextJson("musicState", () => true, 80),
    /Timed out waiting for JSON message musicState/
  );
  assert.equal(
    musicTrackFrom(fixture.server.getState().musicState, "amb_1_2").playing,
    false
  );

  quest.sendJson({ t: "voFinished", stepId: "approach" });
  await dashboard.nextJson(
    "musicState",
    (message) => musicTrackFrom(message, "amb_1_2")?.playing === true
  );
});

test("sequence moves flush pending cues before the entered step's cue", async (t) => {
  for (const timingParams of [
    { timing: "voEnd" },
    { delayMs: 5_000 }
  ]) {
    for (const [action, stepIndex, expectedStepId] of [
      ["next", undefined, "approach"],
      ["goto", 1, "approach"],
      ["start", undefined, "intro"]
    ]) {
      const pendingCue = {
        trackId: "amb_1_2",
        action: "in",
        ...timingParams
      };
      const enteredCue = { trackId: "mus_2_1", action: "in" };
      const sequence =
        action === "start"
          ? sequenceWithMusicCues(enteredCue, pendingCue)
          : sequenceWithMusicCues(pendingCue, enteredCue);
      const fixture = await createRunningServer(t, { sequence });
      const dashboard = await openPeer(t, fixture.wsUrl);
      dashboard.sendJson({ t: "hello", clientType: "dashboard" });
      await dashboard.nextJson("welcome");

      dashboard.sendJson({ t: "seqCommand", action: "start" });
      await dashboard.nextJson(
        "seqState",
        (message) => message.running === true
      );

      if (action === "start") {
        await dashboard.nextJson(
          "musicState",
          (message) => musicTrackFrom(message, "mus_2_1")?.playing === true
        );
        dashboard.sendJson({ t: "seqCommand", action: "next" });
        await dashboard.nextJson(
          "seqState",
          (message) => message.stepId === "approach"
        );
        dashboard.sendJson({
          t: "musicCommand",
          trackId: "mus_2_1",
          action: "stop"
        });
        await dashboard.nextJson(
          "musicState",
          (message) => musicTrackFrom(message, "mus_2_1")?.playing === false
        );
      }

      const command = { t: "seqCommand", action };
      if (stepIndex !== undefined) {
        command.stepIndex = stepIndex;
      }
      dashboard.sendJson(command);
      const flushedState = await dashboard.nextJson("musicState");
      const enteredState = await dashboard.nextJson("musicState");
      const seqState = await dashboard.nextJson(
        "seqState",
        (message) => message.stepId === expectedStepId
      );
      const label = `${action} ${JSON.stringify(timingParams)}`;

      assert.equal(seqState.running, true, label);
      assert.equal(
        musicTrackFrom(flushedState, "amb_1_2").playing,
        true,
        label
      );
      assert.equal(
        musicTrackFrom(flushedState, "mus_2_1").playing,
        false,
        label
      );
      assert.equal(
        musicTrackFrom(enteredState, "amb_1_2").playing,
        true,
        label
      );
      assert.equal(
        musicTrackFrom(enteredState, "mus_2_1").playing,
        true,
        label
      );
    }
  }
});

test("delayMs cues run later and only while still on their entered step", async (t) => {
  const scheduledFixture = await createRunningServer(t, {
    sequence: sequenceWithMusicCues({
      trackId: "amb_1_2",
      action: "in",
      delayMs: 200
    })
  });
  const scheduledDashboard = await openPeer(t, scheduledFixture.wsUrl);
  scheduledDashboard.sendJson({ t: "hello", clientType: "dashboard" });
  await scheduledDashboard.nextJson("welcome");

  scheduledDashboard.sendJson({ t: "seqCommand", action: "start" });
  await scheduledDashboard.nextJson(
    "seqState",
    (message) => message.running === true
  );
  await assert.rejects(
    scheduledDashboard.nextJson("musicState", () => true, 40),
    /Timed out waiting for JSON message musicState/
  );
  await scheduledDashboard.nextJson(
    "musicState",
    (message) => musicTrackFrom(message, "amb_1_2")?.playing === true
  );

  const guardedFixture = await createRunningServer(t, {
    sequence: sequenceWithMusicCues(null, {
      trackId: "mus_2_1",
      action: "in",
      delayMs: 50
    })
  });
  const guardedDashboard = await openPeer(t, guardedFixture.wsUrl);
  guardedDashboard.sendJson({ t: "hello", clientType: "dashboard" });
  await guardedDashboard.nextJson("welcome");

  guardedDashboard.sendJson({ t: "seqCommand", action: "start" });
  await guardedDashboard.nextJson(
    "seqState",
    (message) => message.running === true
  );
  guardedDashboard.sendJson({ t: "seqCommand", action: "next" });
  await guardedDashboard.nextJson(
    "seqState",
    (message) => message.stepId === "approach"
  );
  guardedDashboard.sendJson({ t: "seqCommand", action: "prev" });
  await guardedDashboard.nextJson(
    "seqState",
    (message) => message.stepId === "intro"
  );

  await assert.rejects(
    guardedDashboard.nextJson(
      "musicState",
      (message) => musicTrackFrom(message, "mus_2_1")?.playing === true,
      100
    ),
    /Timed out waiting for JSON message musicState/
  );
  assert.equal(
    musicTrackFrom(
      guardedFixture.server.getState().musicState,
      "mus_2_1"
    ).playing,
    false
  );
});

test("fade stops publish fadeOutSeconds and replay clears it", async (t) => {
  const fixture = await createRunningServer(t, {
    sequence: sequenceWithMusicCues(
      { trackId: "amb_1_2", action: "in" },
      {
        trackId: "amb_1_2",
        action: "out",
        fadeSeconds: 5
      }
    )
  });
  const dashboard = await openPeer(t, fixture.wsUrl);
  dashboard.sendJson({ t: "hello", clientType: "dashboard" });
  await dashboard.nextJson("welcome");

  dashboard.sendJson({ t: "seqCommand", action: "start" });
  await dashboard.nextJson(
    "seqState",
    (message) => message.running === true
  );
  const playingState = await dashboard.nextJson(
    "musicState",
    (message) => musicTrackFrom(message, "amb_1_2")?.playing === true
  );
  assert.equal(
    musicTrackFrom(playingState, "amb_1_2").fadeOutSeconds,
    0
  );

  dashboard.sendJson({ t: "seqCommand", action: "next" });
  await dashboard.nextJson(
    "seqState",
    (message) => message.stepId === "approach"
  );
  const fadedState = await dashboard.nextJson(
    "musicState",
    (message) => musicTrackFrom(message, "amb_1_2")?.playing === false
  );
  assert.equal(
    musicTrackFrom(fadedState, "amb_1_2").fadeOutSeconds,
    5
  );

  dashboard.sendJson({
    t: "musicCommand",
    trackId: "amb_1_2",
    action: "play"
  });
  const replayedState = await dashboard.nextJson(
    "musicState",
    (message) => musicTrackFrom(message, "amb_1_2")?.playing === true
  );
  assert.equal(
    musicTrackFrom(replayedState, "amb_1_2").fadeOutSeconds,
    0
  );
});

test("stop and reset cancel pending voEnd and delayed cues", async (t) => {
  for (const [action, timingParams] of [
    ["stop", { timing: "voEnd" }],
    ["stop", { delayMs: 5_000 }],
    ["reset", { timing: "voEnd" }],
    ["reset", { delayMs: 5_000 }]
  ]) {
    const fixture = await createRunningServer(t, {
      sequence: sequenceWithMusicCues(null, {
        trackId: "amb_1_2",
        action: "in",
        ...timingParams
      })
    });
    const dashboard = await openPeer(t, fixture.wsUrl);
    dashboard.sendJson({ t: "hello", clientType: "dashboard" });
    await dashboard.nextJson("welcome");

    dashboard.sendJson({ t: "seqCommand", action: "start" });
    await dashboard.nextJson(
      "seqState",
      (message) => message.running === true
    );
    dashboard.sendJson({ t: "seqCommand", action: "next" });
    await dashboard.nextJson(
      "seqState",
      (message) => message.stepId === "approach"
    );
    dashboard.sendJson({ t: "seqCommand", action });
    await dashboard.nextJson(
      "seqState",
      (message) => message.running === false
    );
    if (action === "reset") {
      await dashboard.nextJson(
        "musicState",
        (message) => message.tracks.every((track) => !track.playing)
      );
    }

    dashboard.sendJson({ t: "seqCommand", action: "start" });
    await dashboard.nextJson(
      "seqState",
      (message) => message.running === true
    );
    await assert.rejects(
      dashboard.nextJson(
        "musicState",
        (message) => musicTrackFrom(message, "amb_1_2")?.playing === true,
        80
      ),
      /Timed out waiting for JSON message musicState/,
      `${action} ${JSON.stringify(timingParams)}`
    );

    dashboard.sendJson({ t: "seqCommand", action: "stop" });
    await dashboard.nextJson(
      "seqState",
      (message) => message.running === false
    );
  }
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
