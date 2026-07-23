import assert from "node:assert/strict";
import test from "node:test";

import {
  createRoleFrame,
  createWebSocketUrl,
  generateHealth,
  getRoleJpeg,
  parseCliArgs,
  parseDiscoveryResponse
} from "../tools/mock-quest.js";

test("parses discovery mode and the exact direct-mode CLI shape", () => {
  assert.deepEqual(parseCliArgs(["mock-quest-a"]), {
    deviceId: "mock-quest-a",
    directHost: null
  });
  assert.deepEqual(
    parseCliArgs(["mock-quest-b", "--direct", "127.0.0.1"]),
    {
      deviceId: "mock-quest-b",
      directHost: "127.0.0.1"
    }
  );
});

test("rejects missing or blank device IDs", () => {
  for (const args of [[], [""], ["   "], ["--direct", "127.0.0.1"]]) {
    assert.throws(() => parseCliArgs(args), /deviceId|usage/i);
  }
});

test("rejects missing, blank, and non-IPv4 direct hosts", () => {
  for (const args of [
    ["mock-quest-a", "--direct"],
    ["mock-quest-a", "--direct", ""],
    ["mock-quest-a", "--direct", "   "],
    ["mock-quest-a", "--direct", "localhost"],
    ["mock-quest-a", "--direct", "999.1.1.1"]
  ]) {
    assert.throws(() => parseCliArgs(args), /direct|IPv4|usage/i);
  }
});

test("rejects unknown, duplicate, and extra CLI arguments", () => {
  for (const args of [
    ["mock-quest-a", "--unknown"],
    [
      "mock-quest-a",
      "--direct",
      "127.0.0.1",
      "--direct",
      "127.0.0.2"
    ],
    ["mock-quest-a", "mock-quest-b"],
    ["mock-quest-a", "--direct", "127.0.0.1", "extra"]
  ]) {
    assert.throws(() => parseCliArgs(args), /argument|duplicate|usage/i);
  }
});

test("parses only an exact valid discovery response", () => {
  const response = Buffer.from(
    'VA_SERVER {"ip":"192.0.2.44","port":8080}',
    "utf8"
  );
  assert.deepEqual(parseDiscoveryResponse(response), {
    host: "192.0.2.44",
    port: 8080
  });
});

test("rejects malformed discovery prefixes and JSON suffixes", () => {
  for (const response of [
    "",
    "VA_SERVER",
    "VA_SERVER ",
    'VA_SERVER? {"ip":"192.0.2.44","port":8080}',
    ' VA_SERVER {"ip":"192.0.2.44","port":8080}',
    "VA_SERVER not-json",
    "VA_SERVER null",
    "VA_SERVER []"
  ]) {
    assert.throws(
      () => parseDiscoveryResponse(response),
      /discovery|VA_SERVER|JSON|response/i
    );
  }
});

test("rejects discovery responses without a valid IPv4 host and TCP port", () => {
  for (const response of [
    'VA_SERVER {"port":8080}',
    'VA_SERVER {"ip":"","port":8080}',
    'VA_SERVER {"ip":"   ","port":8080}',
    'VA_SERVER {"ip":"server.local","port":8080}',
    'VA_SERVER {"ip":"999.1.1.1","port":8080}',
    'VA_SERVER {"ip":"192.0.2.44"}',
    'VA_SERVER {"ip":"192.0.2.44","port":"8080"}',
    'VA_SERVER {"ip":"192.0.2.44","port":0}',
    'VA_SERVER {"ip":"192.0.2.44","port":65536}'
  ]) {
    assert.throws(
      () => parseDiscoveryResponse(response),
      /IPv4|host|port|response/i
    );
  }
});

test("constructs the exact WebSocket endpoint and validates its inputs", () => {
  assert.equal(
    createWebSocketUrl("127.0.0.1", 8080),
    "ws://127.0.0.1:8080/ws"
  );
  assert.throws(() => createWebSocketUrl("", 8080), /IPv4|host/i);
  assert.throws(
    () => createWebSocketUrl("localhost", 8080),
    /IPv4|host/i
  );
  assert.throws(
    () => createWebSocketUrl("127.0.0.1", 0),
    /port/i
  );
  assert.throws(
    () => createWebSocketUrl("127.0.0.1", 65536),
    /port/i
  );
});

test("generates a complete plausible health sample", () => {
  const health = generateHealth(0, () => 0.5);

  assert.deepEqual(Object.keys(health), [
    "t",
    "fps",
    "cvHz",
    "cvMs",
    "batteryPct",
    "markers",
    "dist",
    "trackingOk"
  ]);
  assert.equal(health.t, "health");
  assert.ok(health.fps >= 70 && health.fps <= 75);
  assert.ok(health.cvHz >= 24 && health.cvHz <= 32);
  assert.ok(health.cvMs >= 8 && health.cvMs <= 20);
  assert.ok(health.batteryPct >= 55 && health.batteryPct <= 100);
  assert.deepEqual(health.markers, [10, 20]);
  assert.equal(health.trackingOk, true);

  assert.deepEqual(Object.keys(health.dist), [
    "markerToMarker",
    "selfToOwn",
    "selfToOther"
  ]);
  for (const distance of Object.values(health.dist)) {
    assert.equal(typeof distance, "number");
    assert.ok(distance >= 0.1 && distance <= 2);
  }
});

test("drifts distances sinusoidally over time", () => {
  const first = generateHealth(0, () => 0.5);
  const later = generateHealth(2_000, () => 0.5);

  assert.notEqual(
    first.dist.markerToMarker,
    later.dist.markerToMarker
  );
  assert.notEqual(first.dist.selfToOwn, later.dist.selfToOwn);
  assert.notEqual(first.dist.selfToOther, later.dist.selfToOther);
});

test("models a deterministic marker dropout with nullable distances", () => {
  const health = generateHealth(1_000, () => 0);

  assert.equal(health.trackingOk, false);
  assert.ok(health.markers.length < 2);
  assert.ok(
    health.markers.every((markerId) => markerId === 10 || markerId === 20)
  );

  const distances = Object.values(health.dist);
  assert.ok(distances.filter((distance) => distance === null).length >= 2);
  for (const distance of distances) {
    assert.ok(
      distance === null ||
        (typeof distance === "number" &&
          Number.isFinite(distance) &&
          distance >= 0)
    );
  }
});

test("maps marker dropout distances to the assigned A or B role", () => {
  const roleA = generateHealth(1_000, () => 0, "A");
  const roleB = generateHealth(1_000, () => 0, "B");

  assert.deepEqual(roleA.markers, [20]);
  assert.equal(roleA.dist.selfToOwn, null);
  assert.equal(typeof roleA.dist.selfToOther, "number");

  assert.deepEqual(roleB.markers, [20]);
  assert.equal(typeof roleB.dist.selfToOwn, "number");
  assert.equal(roleB.dist.selfToOther, null);
});

test("provides distinct meaningful JPEGs and role-prefixed frames", () => {
  const jpegA = getRoleJpeg("A");
  const jpegB = getRoleJpeg("B");

  for (const jpeg of [jpegA, jpegB]) {
    assert.ok(Buffer.isBuffer(jpeg));
    assert.ok(jpeg.length > 100);
    assert.deepEqual(jpeg.subarray(0, 2), Buffer.from([0xff, 0xd8]));
    assert.deepEqual(jpeg.subarray(-2), Buffer.from([0xff, 0xd9]));
  }
  assert.notDeepEqual(jpegA, jpegB);

  const frameA = createRoleFrame("A");
  const frameB = createRoleFrame("B");
  assert.equal(frameA[0], 0x41);
  assert.equal(frameB[0], 0x42);
  assert.deepEqual(frameA.subarray(1), jpegA);
  assert.deepEqual(frameB.subarray(1), jpegB);

  assert.throws(() => getRoleJpeg("C"), /role/i);
  assert.throws(() => createRoleFrame(null), /role/i);
});
