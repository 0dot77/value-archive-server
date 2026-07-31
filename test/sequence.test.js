import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSequenceController,
  loadSequence
} from "../src/sequence.js";

const validSequence = {
  sequenceId: "performance-v1",
  steps: [
    {
      stepId: "intro",
      title: "인트로",
      targets: ["A", "B"],
      trigger: { type: "manual" },
      params: { cue: { color: "blue" } }
    },
    {
      stepId: "approach",
      title: "명함 접근",
      targets: ["A", "B"],
      trigger: {
        type: "condition",
        metric: "markerToMarker",
        op: "<",
        valueMeters: 0.3,
        holdMs: 500,
        source: "any"
      },
      params: { prompt: "approach" }
    },
    {
      stepId: "hold",
      title: "대기",
      targets: ["B"],
      trigger: {
        type: "timer",
        afterMs: 1000
      }
    }
  ]
};

const validMusicCatalog = [
  {
    trackId: "amb_1_2",
    label: "Ambient 1/2",
    file: "music/ambient-1-2.mp3"
  },
  {
    trackId: "amb_3",
    label: "Ambient 3",
    file: "music/ambient-3.mp3"
  },
  {
    trackId: "ending",
    label: "Ending",
    file: "music/ending.mp3"
  }
];

function clone(value) {
  return structuredClone(value);
}

async function writeSequenceFixture(t, document) {
  const directory = await mkdtemp(path.join(tmpdir(), "va-sequence-"));
  const filePath = path.join(directory, "sequence.json");
  await writeFile(filePath, JSON.stringify(document), "utf8");
  t.after(() => rm(directory, { recursive: true, force: true }));
  return filePath;
}

test("loads and normalizes the supplied v1 sequence schema", async (t) => {
  const filePath = await writeSequenceFixture(t, validSequence);

  const sequence = await loadSequence(filePath);

  assert.equal(sequence.sequenceId, "performance-v1");
  assert.equal(sequence.steps.length, 3);
  assert.deepEqual(sequence.steps[0], validSequence.steps[0]);
  assert.deepEqual(sequence.steps[1].trigger, validSequence.steps[1].trigger);
  assert.deepEqual(sequence.steps[2], {
    ...validSequence.steps[2],
    params: {}
  });
});

test("normalizes missing top-level music to an empty array", async (t) => {
  const filePath = await writeSequenceFixture(t, validSequence);

  const sequence = await loadSequence(filePath);

  assert.deepEqual(sequence.music, []);
});

test("normalizes a three-track music catalog exactly and preserves order", async (t) => {
  const document = clone(validSequence);
  document.music = clone(validMusicCatalog);
  const filePath = await writeSequenceFixture(t, document);

  const sequence = await loadSequence(filePath);

  assert.deepEqual(sequence.music, [
    {
      trackId: "amb_1_2",
      label: "Ambient 1/2",
      file: "music/ambient-1-2.mp3"
    },
    {
      trackId: "amb_3",
      label: "Ambient 3",
      file: "music/ambient-3.mp3"
    },
    {
      trackId: "ending",
      label: "Ending",
      file: "music/ending.mp3"
    }
  ]);
});

test("rejects malformed top-level music catalog shapes", async (t) => {
  for (const [label, music, expectedPath] of [
    ["non-array catalog", "amb_1_2", /music/],
    ["null catalog", null, /music/],
    ["non-object track", [null], /music\[0\]/]
  ]) {
    const document = clone(validSequence);
    document.music = music;
    const filePath = await writeSequenceFixture(t, document);

    await assert.rejects(
      loadSequence(filePath),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, expectedPath);
        return true;
      },
      label
    );
  }
});

test("rejects duplicate music track IDs with the duplicate field path", async (t) => {
  const document = clone(validSequence);
  document.music = clone(validMusicCatalog);
  document.music[2].trackId = "amb_1_2";
  const filePath = await writeSequenceFixture(t, document);

  await assert.rejects(loadSequence(filePath), (error) => {
    assert.ok(error instanceof TypeError);
    assert.match(error.message, /music\[2\]\.trackId/);
    assert.match(error.message, /duplicate|unique/i);
    return true;
  });
});

test("rejects blank or non-string music fields with exact indexed paths", async (t) => {
  for (const [label, index, field, value, expectedPath] of [
    ["blank trackId", 0, "trackId", " ", /music\[0\]\.trackId/],
    ["non-string trackId", 1, "trackId", 12, /music\[1\]\.trackId/],
    ["blank label", 2, "label", "", /music\[2\]\.label/],
    ["non-string label", 0, "label", false, /music\[0\]\.label/],
    ["blank file", 1, "file", " ", /music\[1\]\.file/],
    ["non-string file", 2, "file", {}, /music\[2\]\.file/]
  ]) {
    const document = clone(validSequence);
    document.music = clone(validMusicCatalog);
    document.music[index][field] = value;
    const filePath = await writeSequenceFixture(t, document);

    await assert.rejects(
      loadSequence(filePath),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, expectedPath);
        return true;
      },
      label
    );
  }
});

test("rejects malformed sequence IDs and step collections", async (t) => {
  for (const [label, document, expected] of [
    ["empty ID", { sequenceId: " ", steps: validSequence.steps }, /sequenceId/i],
    ["missing steps", { sequenceId: "valid" }, /steps/i],
    ["empty steps", { sequenceId: "valid", steps: [] }, /steps/i],
    ["non-object step", { sequenceId: "valid", steps: [null] }, /steps\[0\]/i],
    [
      "missing step ID",
      {
        sequenceId: "valid",
        steps: [{ ...validSequence.steps[0], stepId: undefined }]
      },
      /stepId/i
    ],
    [
      "blank step ID",
      {
        sequenceId: "valid",
        steps: [{ ...validSequence.steps[0], stepId: " " }]
      },
      /stepId/i
    ],
    [
      "duplicate step ID",
      {
        sequenceId: "valid",
        steps: [validSequence.steps[0], validSequence.steps[0]]
      },
      /stepId.*unique|duplicate.*stepId/i
    ],
    [
      "empty title",
      {
        sequenceId: "valid",
        steps: [{ ...validSequence.steps[0], title: "" }]
      },
      /title/i
    ],
    [
      "array params",
      {
        sequenceId: "valid",
        steps: [{ ...validSequence.steps[0], params: [] }]
      },
      /params/i
    ]
  ]) {
    const filePath = await writeSequenceFixture(t, document);
    await assert.rejects(loadSequence(filePath), expected, label);
  }
});

test("rejects malformed step targets", async (t) => {
  for (const [label, targets] of [
    ["not an array", "A"],
    ["empty", []],
    ["unknown role", ["C"]],
    ["duplicate role", ["A", "A"]]
  ]) {
    const document = clone(validSequence);
    document.steps[0].targets = targets;
    const filePath = await writeSequenceFixture(t, document);
    await assert.rejects(loadSequence(filePath), /targets/i, label);
  }
});

test("rejects malformed manual, timer, and condition triggers", async (t) => {
  const malformedTriggers = [
    ["missing trigger", undefined],
    ["unsupported type", { type: "automatic" }],
    ["negative timer", { type: "timer", afterMs: -1 }],
    ["fractional timer", { type: "timer", afterMs: 1.5 }],
    [
      "unknown metric",
      {
        type: "condition",
        metric: "unknown",
        op: "<",
        valueMeters: 0.3,
        holdMs: 500,
        source: "any"
      }
    ],
    [
      "unknown operator",
      {
        type: "condition",
        metric: "markerToMarker",
        op: "!=",
        valueMeters: 0.3,
        holdMs: 500,
        source: "any"
      }
    ],
    [
      "negative threshold",
      {
        type: "condition",
        metric: "markerToMarker",
        op: "<",
        valueMeters: -0.3,
        holdMs: 500,
        source: "any"
      }
    ],
    [
      "fractional hold",
      {
        type: "condition",
        metric: "markerToMarker",
        op: "<",
        valueMeters: 0.3,
        holdMs: 1.5,
        source: "any"
      }
    ],
    [
      "unknown source",
      {
        type: "condition",
        metric: "markerToMarker",
        op: "<",
        valueMeters: 0.3,
        holdMs: 500,
        source: "all"
      }
    ]
  ];

  for (const [label, trigger] of malformedTriggers) {
    const document = clone(validSequence);
    document.steps[0].trigger = trigger;
    const filePath = await writeSequenceFixture(t, document);
    await assert.rejects(loadSequence(filePath), /trigger/i, label);
  }
});

test("exposes the exact initial public state with cloned params", () => {
  const sequence = clone(validSequence);
  const controller = createSequenceController(sequence, { now: () => 1000 });

  const state = controller.getState();

  assert.deepEqual(state, {
    sequenceId: "performance-v1",
    running: false,
    stepIndex: 0,
    stepId: "intro",
    enteredAtServerMs: 1000,
    params: { cue: { color: "blue" } }
  });
  state.params.cue.color = "red";
  sequence.steps[0].params.cue.color = "green";
  assert.deepEqual(controller.getState().params, {
    cue: { color: "blue" }
  });
});

test("start selects index zero and stop preserves the selected step", () => {
  const timestamps = [10, 20, 30, 40];
  const controller = createSequenceController(clone(validSequence), {
    now: () => timestamps.shift()
  });

  assert.equal(controller.command("goto", 2).stepIndex, 2);
  assert.deepEqual(controller.command("start"), {
    sequenceId: "performance-v1",
    running: true,
    stepIndex: 0,
    stepId: "intro",
    enteredAtServerMs: 30,
    params: { cue: { color: "blue" } }
  });
  assert.deepEqual(controller.command("stop"), {
    sequenceId: "performance-v1",
    running: false,
    stepIndex: 0,
    stepId: "intro",
    enteredAtServerMs: 40,
    params: { cue: { color: "blue" } }
  });
});

test("reset selects index zero and stops a running sequence, unlike start", () => {
  const timestamps = [10, 20, 30, 40];
  const controller = createSequenceController(clone(validSequence), {
    now: () => timestamps.shift()
  });

  assert.equal(controller.command("start").running, true);

  const beforeReset = controller.command("goto", 2);
  assert.equal(beforeReset.running, true);
  assert.equal(beforeReset.stepIndex, 2);

  assert.deepEqual(controller.command("reset"), {
    sequenceId: "performance-v1",
    running: false,
    stepIndex: 0,
    stepId: "intro",
    enteredAtServerMs: 40,
    params: { cue: { color: "blue" } }
  });
});

test("next and prev clamp while every valid command gets a fresh timestamp", () => {
  let timestamp = 100;
  const controller = createSequenceController(clone(validSequence), {
    now: () => timestamp++
  });

  assert.deepEqual(
    [
      controller.command("prev"),
      controller.command("next"),
      controller.command("next"),
      controller.command("next"),
      controller.command("prev")
    ].map(({ stepIndex, enteredAtServerMs }) => [
      stepIndex,
      enteredAtServerMs
    ]),
    [
      [0, 101],
      [1, 102],
      [2, 103],
      [2, 104],
      [1, 105]
    ]
  );
});

test("goto selects valid indices and rejects invalid indices or actions", () => {
  let timestamp = 200;
  const controller = createSequenceController(clone(validSequence), {
    now: () => timestamp++
  });

  const selected = controller.command("goto", 1);
  assert.equal(selected.stepIndex, 1);
  assert.equal(selected.stepId, "approach");
  assert.deepEqual(selected.params, { prompt: "approach" });
  selected.params.prompt = "mutated";
  assert.deepEqual(controller.getState().params, { prompt: "approach" });

  for (const stepIndex of [-1, 3, 1.5, "1", undefined]) {
    assert.throws(
      () => controller.command("goto", stepIndex),
      /goto|stepIndex/i
    );
  }
  assert.throws(() => controller.command("rewind"), /action/i);
  assert.equal(controller.getState().enteredAtServerMs, 201);
});
