import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createRegistry } from "../src/registry.js";

async function createFixture(t, contents = "{}") {
  const directory = await mkdtemp(path.join(tmpdir(), "va-registry-"));
  const filePath = path.join(directory, "devices.json");
  await writeFile(filePath, contents, "utf8");
  t.after(() => rm(directory, { recursive: true, force: true }));
  return filePath;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

test("loads an empty registry and returns defensive assignment copies", async (t) => {
  const filePath = await createFixture(t);
  const registry = createRegistry({ filePath });

  assert.deepEqual(await registry.load(), {});
  assert.equal(registry.getRole("unknown-device"), null);

  const assignments = registry.getAssignments();
  assignments.injected = "A";
  assert.deepEqual(registry.getAssignments(), {});
});

test("rejects duplicate persisted roles with both conflicting device IDs", async (t) => {
  const filePath = await createFixture(
    t,
    JSON.stringify({
      "quest-alpha": "A",
      "quest-beta": "A"
    })
  );
  const registry = createRegistry({ filePath });

  await assert.rejects(registry.load(), (error) => {
    assert.match(error.message, /role A/i);
    assert.match(error.message, /quest-alpha/i);
    assert.match(error.message, /quest-beta/i);
    return true;
  });
  assert.deepEqual(registry.getAssignments(), {});
});

test("persists an assignment for a newly loaded registry", async (t) => {
  const filePath = await createFixture(t);
  const registry = createRegistry({ filePath });
  await registry.load();

  const returned = await registry.assignRole("quest-alpha", "A");

  assert.deepEqual(returned, { "quest-alpha": "A" });
  returned["quest-alpha"] = "B";
  assert.equal(registry.getRole("quest-alpha"), "A");
  assert.deepEqual(await readJson(filePath), { "quest-alpha": "A" });

  const reloaded = createRegistry({ filePath });
  await reloaded.load();
  assert.equal(reloaded.getRole("quest-alpha"), "A");
});

test("assigning an occupied role removes it from the previous device", async (t) => {
  const filePath = await createFixture(t);
  const registry = createRegistry({ filePath });
  await registry.load();
  await registry.assignRole("quest-alpha", "A");

  await registry.assignRole("quest-beta", "A");

  assert.equal(registry.getRole("quest-alpha"), null);
  assert.equal(registry.getRole("quest-beta"), "A");
  assert.deepEqual(await readJson(filePath), { "quest-beta": "A" });
});

test("rejects empty device IDs and roles other than A or B", async (t) => {
  const filePath = await createFixture(t);
  const registry = createRegistry({ filePath });
  await registry.load();

  await assert.rejects(registry.assignRole("", "A"), /deviceId/i);
  await assert.rejects(registry.assignRole("   ", "A"), /deviceId/i);
  await assert.rejects(registry.assignRole("quest-alpha", "C"), /role/i);

  assert.deepEqual(registry.getAssignments(), {});
  assert.deepEqual(await readJson(filePath), {});
});

test("serialized assignments leave valid JSON after every awaited write", async (t) => {
  const filePath = await createFixture(t);
  const registry = createRegistry({ filePath });
  await registry.load();

  await registry.assignRole("quest-alpha", "A");
  assert.deepEqual(await readJson(filePath), { "quest-alpha": "A" });

  await registry.assignRole("quest-beta", "B");
  assert.deepEqual(await readJson(filePath), {
    "quest-alpha": "A",
    "quest-beta": "B"
  });

  const stealA = registry.assignRole("quest-gamma", "A");
  const stealB = registry.assignRole("quest-delta", "B");
  await Promise.all([stealA, stealB]);
  assert.deepEqual(await readJson(filePath), {
    "quest-gamma": "A",
    "quest-delta": "B"
  });
});

test("a failed write rolls back state, cleans up, and does not poison later writes", async (t) => {
  const filePath = await createFixture(t);
  const backupPath = `${filePath}.backup`;
  const registry = createRegistry({
    filePath,
    logger: {
      error() {
        throw new Error("logger failed");
      }
    }
  });
  await registry.load();
  await registry.assignRole("quest-alpha", "A");

  await rename(filePath, backupPath);
  await mkdir(filePath);

  await assert.rejects(registry.assignRole("quest-beta", "B"));
  assert.deepEqual(registry.getAssignments(), { "quest-alpha": "A" });
  assert.deepEqual(await readJson(backupPath), { "quest-alpha": "A" });

  const temporaryPrefix = `.${path.basename(filePath)}.`;
  const directoryEntries = await readdir(path.dirname(filePath));
  assert.equal(
    directoryEntries.some((entry) => entry.startsWith(temporaryPrefix)),
    false
  );

  await rm(filePath, { recursive: true });
  await rename(backupPath, filePath);

  await registry.assignRole("quest-beta", "B");
  assert.deepEqual(await readJson(filePath), {
    "quest-alpha": "A",
    "quest-beta": "B"
  });
});
