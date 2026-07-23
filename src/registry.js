import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";

const VALID_ROLES = new Set(["A", "B"]);

function validateDeviceId(deviceId) {
  if (typeof deviceId !== "string" || deviceId.trim().length === 0) {
    throw new TypeError("deviceId must be a non-empty string");
  }
}

function validateRole(role) {
  if (!VALID_ROLES.has(role)) {
    throw new TypeError('role must be either "A" or "B"');
  }
}

function parseAssignments(contents, filePath) {
  let document;

  try {
    document = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid registry JSON at ${filePath}: ${error.message}`, {
      cause: error
    });
  }

  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document)
  ) {
    throw new TypeError("Registry document must be a JSON object");
  }

  const entries = Object.entries(document);
  const occupiedRoles = new Map();

  for (const [deviceId, role] of entries) {
    validateDeviceId(deviceId);
    validateRole(role);
    if (occupiedRoles.has(role)) {
      throw new Error(
        `Registry role ${role} is assigned to both ` +
          `${occupiedRoles.get(role)} and ${deviceId}`
      );
    }
    occupiedRoles.set(role, deviceId);
  }

  return new Map(entries);
}

function cloneAssignments(assignments) {
  return Object.fromEntries(assignments);
}

async function writeAtomically(filePath, assignments) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  const contents = `${JSON.stringify(cloneAssignments(assignments), null, 2)}\n`;

  await mkdir(directory, { recursive: true });

  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx"
    });
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

export function createRegistry({ filePath, logger } = {}) {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new TypeError("filePath must be a non-empty string");
  }

  let assignments = new Map();
  let operationChain = Promise.resolve();

  function enqueue(operation) {
    const pending = operationChain.then(operation);
    operationChain = pending.catch((error) => {
      try {
        logger?.error?.(`[VA] Registry operation failed: ${error.message}`);
      } catch {
        // Logging must not leave the persistence queue rejected.
      }
    });
    return pending;
  }

  async function load() {
    return enqueue(async () => {
      const contents = await readFile(filePath, "utf8");
      assignments = parseAssignments(contents, filePath);
      return cloneAssignments(assignments);
    });
  }

  function getRole(deviceId) {
    return assignments.get(deviceId) ?? null;
  }

  function getAssignments() {
    return cloneAssignments(assignments);
  }

  async function assignRole(deviceId, role) {
    validateDeviceId(deviceId);
    validateRole(role);

    return enqueue(async () => {
      const nextAssignments = new Map(assignments);

      for (const [assignedDeviceId, assignedRole] of nextAssignments) {
        if (assignedRole === role) {
          nextAssignments.delete(assignedDeviceId);
        }
      }
      nextAssignments.set(deviceId, role);

      await writeAtomically(filePath, nextAssignments);
      assignments = nextAssignments;
      return cloneAssignments(assignments);
    });
  }

  return {
    load,
    getRole,
    getAssignments,
    assignRole
  };
}
