import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as serverModule from "../src/server.js";

const DASHBOARD_URL = "http://localhost:43210";

function createSpawnFixture() {
  const calls = [];
  const child = new EventEmitter();
  let unrefCalls = 0;

  child.unref = () => {
    unrefCalls += 1;
  };

  return {
    calls,
    child,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
    getUnrefCalls() {
      return unrefCalls;
    }
  };
}

function createWarningLogger() {
  const warnings = [];
  return {
    logger: {
      warn(message) {
        warnings.push(message);
      }
    },
    warnings
  };
}

test("selects the platform browser command and detaches the launcher", () => {
  const scenarios = [
    {
      platform: "win32",
      expectedCall: {
        command: "cmd",
        args: ["/c", "start", "", DASHBOARD_URL]
      }
    },
    {
      platform: "darwin",
      expectedCall: {
        command: "open",
        args: [DASHBOARD_URL]
      }
    },
    {
      platform: "linux",
      expectedCall: {
        command: "xdg-open",
        args: [DASHBOARD_URL]
      }
    }
  ];

  for (const { platform, expectedCall } of scenarios) {
    const fixture = createSpawnFixture();

    serverModule.openDashboardInBrowser(DASHBOARD_URL, {
      platform,
      spawn: fixture.spawn,
      logger: { warn() {} }
    });

    assert.equal(fixture.calls.length, 1);
    const [{ command, args, options }] = fixture.calls;
    assert.deepEqual({ command, args }, expectedCall);
    assert.deepEqual(options, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    assert.equal(fixture.getUnrefCalls(), 1);
  }
});

test("isolates a synchronous browser launcher failure", () => {
  const { logger, warnings } = createWarningLogger();

  assert.doesNotThrow(() => {
    serverModule.openDashboardInBrowser(DASHBOARD_URL, {
      platform: "linux",
      spawn() {
        throw new Error("spawn failed");
      },
      logger
    });
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[VA\].*spawn failed/);
});

test("isolates an asynchronous browser launcher error", () => {
  const fixture = createSpawnFixture();
  const { logger, warnings } = createWarningLogger();

  serverModule.openDashboardInBrowser(DASHBOARD_URL, {
    platform: "linux",
    spawn: fixture.spawn,
    logger
  });

  assert.doesNotThrow(() => {
    fixture.child.emit("error", new Error("launcher error"));
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[VA\].*launcher error/);
});

test("warns once when the browser launcher exits unsuccessfully", () => {
  const fixture = createSpawnFixture();
  const { logger, warnings } = createWarningLogger();

  serverModule.openDashboardInBrowser(DASHBOARD_URL, {
    platform: "linux",
    spawn: fixture.spawn,
    logger
  });

  assert.doesNotThrow(() => {
    fixture.child.emit("exit", 7, null);
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[VA\].*7/);
});

test("keeps automatic browser launch inside the successful CLI boundary", async () => {
  const source = await readFile(
    new URL("../src/server.js", import.meta.url),
    "utf8"
  );
  const factoryStart = source.indexOf(
    "export function createValueArchiveServer"
  );
  const cliHelperStart = source.indexOf("function isCommandLineEntryPoint");
  const cliBoundaryStart = source.indexOf(
    "if (isCommandLineEntryPoint())"
  );

  assert.notEqual(factoryStart, -1);
  assert.notEqual(cliHelperStart, -1);
  assert.notEqual(cliBoundaryStart, -1);

  const factorySource = source.slice(factoryStart, cliHelperStart);
  assert.doesNotMatch(factorySource, /\bopenDashboardInBrowser\s*\(/);

  const cliSource = source.slice(cliBoundaryStart);
  assert.equal(
    [...cliSource.matchAll(/\bopenDashboardInBrowser\s*\(/g)].length,
    1
  );
  assert.match(
    cliSource,
    /server\.start\(\)\.then\(\(address\) => \{\s*if \(!shuttingDown && process\.env\.VA_NO_OPEN !== "1"\) \{\s*openDashboardInBrowser\(\s*`http:\/\/localhost:\$\{address\.http\.port\}`,\s*\{ logger: console \}\s*\);\s*\}\s*\}\)\.catch/
  );
});
