import { readFile } from "node:fs/promises";

const VALID_ROLES = new Set(["A", "B"]);
const VALID_METRICS = new Set([
  "markerToMarker",
  "selfToOwn",
  "selfToOther"
]);
const VALID_OPERATORS = new Set(["<", "<=", ">", ">="]);
const VALID_SOURCES = new Set(["A", "B", "any", "both"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function requireNonEmptyString(value, fieldPath) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${fieldPath} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeInteger(value, fieldPath) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${fieldPath} must be a non-negative integer`);
  }
  return value;
}

function requireNonNegativeNumber(value, fieldPath) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${fieldPath} must be a non-negative finite number`);
  }
  return value;
}

function normalizeTargets(targets, fieldPath) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new TypeError(`${fieldPath} must be a non-empty array`);
  }

  const uniqueTargets = new Set();

  for (const target of targets) {
    if (!VALID_ROLES.has(target)) {
      throw new TypeError(`${fieldPath} may contain only roles A and B`);
    }
    if (uniqueTargets.has(target)) {
      throw new TypeError(`${fieldPath} may not contain duplicate roles`);
    }
    uniqueTargets.add(target);
  }

  return [...targets];
}

function normalizeTrigger(trigger, fieldPath) {
  if (!isObject(trigger)) {
    throw new TypeError(`${fieldPath} must be an object`);
  }

  switch (trigger.type) {
    case "manual":
      return { type: "manual" };

    case "timer":
      return {
        type: "timer",
        afterMs: requireNonNegativeInteger(
          trigger.afterMs,
          `${fieldPath}.afterMs`
        )
      };

    case "condition": {
      if (!VALID_METRICS.has(trigger.metric)) {
        throw new TypeError(
          `${fieldPath}.metric must be markerToMarker, selfToOwn, or selfToOther`
        );
      }
      if (!VALID_OPERATORS.has(trigger.op)) {
        throw new TypeError(`${fieldPath}.op is not a supported operator`);
      }
      if (!VALID_SOURCES.has(trigger.source)) {
        throw new TypeError(
          `${fieldPath}.source must be A, B, any, or both`
        );
      }

      return {
        type: "condition",
        metric: trigger.metric,
        op: trigger.op,
        valueMeters: requireNonNegativeNumber(
          trigger.valueMeters,
          `${fieldPath}.valueMeters`
        ),
        holdMs: requireNonNegativeInteger(
          trigger.holdMs,
          `${fieldPath}.holdMs`
        ),
        source: trigger.source
      };
    }

    default:
      throw new TypeError(
        `${fieldPath}.type must be manual, timer, or condition`
      );
  }
}

function normalizeSequence(sequence) {
  if (!isObject(sequence)) {
    throw new TypeError("Sequence document must be a JSON object");
  }

  const sequenceId = requireNonEmptyString(
    sequence.sequenceId,
    "sequenceId"
  );
  if (!Array.isArray(sequence.steps) || sequence.steps.length === 0) {
    throw new TypeError("steps must be a non-empty array");
  }

  const stepIds = new Set();
  const steps = sequence.steps.map((step, index) => {
    const fieldPath = `steps[${index}]`;
    if (!isObject(step)) {
      throw new TypeError(`${fieldPath} must be an object`);
    }

    const stepId = requireNonEmptyString(
      step.stepId,
      `${fieldPath}.stepId`
    );
    if (stepIds.has(stepId)) {
      throw new TypeError(`stepId values must be unique; duplicate ${stepId}`);
    }
    stepIds.add(stepId);

    const params = step.params ?? {};
    if (!isObject(params)) {
      throw new TypeError(`${fieldPath}.params must be an object`);
    }

    return {
      stepId,
      title: requireNonEmptyString(step.title, `${fieldPath}.title`),
      targets: normalizeTargets(step.targets, `${fieldPath}.targets`),
      trigger: normalizeTrigger(step.trigger, `${fieldPath}.trigger`),
      params: clone(params)
    };
  });

  return { sequenceId, steps };
}

export async function loadSequence(filePath) {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new TypeError("filePath must be a non-empty string");
  }

  const contents = await readFile(filePath, "utf8");
  let document;

  try {
    document = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid sequence JSON at ${filePath}: ${error.message}`, {
      cause: error
    });
  }

  return normalizeSequence(document);
}

export function createSequenceController(sequence, { now = Date.now } = {}) {
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }

  const normalizedSequence = normalizeSequence(sequence);
  let running = false;
  let stepIndex = 0;
  let enteredAtServerMs = readTimestamp();

  function readTimestamp() {
    const timestamp = now();
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
      throw new TypeError("now must return a finite number");
    }
    return timestamp;
  }

  function getState() {
    const step = normalizedSequence.steps[stepIndex];
    return {
      sequenceId: normalizedSequence.sequenceId,
      running,
      stepIndex,
      stepId: step.stepId,
      enteredAtServerMs,
      params: clone(step.params)
    };
  }

  function command(action, gotoIndex) {
    let nextRunning = running;
    let nextStepIndex = stepIndex;

    switch (action) {
      case "start":
        nextRunning = true;
        nextStepIndex = 0;
        break;
      case "stop":
        nextRunning = false;
        break;
      case "next":
        nextStepIndex = Math.min(
          stepIndex + 1,
          normalizedSequence.steps.length - 1
        );
        break;
      case "prev":
        nextStepIndex = Math.max(stepIndex - 1, 0);
        break;
      case "goto":
        if (
          !Number.isSafeInteger(gotoIndex) ||
          gotoIndex < 0 ||
          gotoIndex >= normalizedSequence.steps.length
        ) {
          throw new RangeError("goto stepIndex is outside the sequence");
        }
        nextStepIndex = gotoIndex;
        break;
      default:
        throw new TypeError(`Invalid sequence action: ${String(action)}`);
    }

    const nextTimestamp = readTimestamp();
    running = nextRunning;
    stepIndex = nextStepIndex;
    enteredAtServerMs = nextTimestamp;
    return getState();
  }

  return { getState, command };
}
