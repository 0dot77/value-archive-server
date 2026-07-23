# Value Archive Performance Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Node.js performance server, offline dashboard, persistent device-role registry, server-authoritative sequence controller, and hardware-free Quest simulator specified by `network-performance-design.md`.

**Architecture:** One Express HTTP server owns the static dashboard and REST diagnostics while a `ws` server attached at `/ws` owns Quest/dashboard fan-out. A UDP socket performs LAN discovery. Focused sequence and registry modules keep state-machine and persistence behavior independently testable with Node's built-in test runner.

**Tech Stack:** Node.js 22, plain ESM JavaScript, Express, `ws`, vanilla HTML/CSS/JavaScript, `node:test`.

## Global Constraints

- Production uses Node.js 22 with `"type": "module"` and no transpiler, bundler, TypeScript, frontend framework, or CDN.
- `express` and `ws` are the only runtime dependencies.
- HTTP and WebSocket share TCP port `8765`; WebSocket upgrades are accepted only at `/ws`.
- UDP discovery listens on `47800` and answers exact payload `VA_DISCOVER?` with `VA_SERVER {"ip":"<lan-ip>","port":<actual-bound-http-port>}`.
- All JSON WebSocket messages contain `t`; screenshot frames are binary and retain the leading ASCII role byte.
- Health older than 5 seconds is offline; pings are sent every 2 seconds; device updates are pushed immediately on change and every 1 second.
- Registry writes are atomic and role assignment is unique: assigning an occupied role unassigns the old device.
- Sequence transitions are server-authoritative and stamp `enteredAtServerMs`; timer and condition triggers validate but do not auto-advance in v1.
- Dashboard data is push-driven over one reconnecting WebSocket; only relative-time rendering uses a 1-second timer.
- Runtime logging starts with `[VA]`.
- The repository receives one descriptive final commit after all verification, as requested.

---

### Task 1: Project metadata, fixtures, and pure state modules

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `data/devices.json`
- Create: `data/sequence.json`
- Create: `src/registry.js`
- Create: `src/sequence.js`
- Create: `test/registry.test.js`
- Create: `test/sequence.test.js`

**Interfaces:**
- `createRegistry({ filePath, logger? })` returns an object with async `load()`, `getRole(deviceId)`, `getAssignments()`, and `assignRole(deviceId, role)`.
- `loadSequence(filePath)` returns a validated, normalized sequence document or throws a descriptive validation error.
- `createSequenceController(sequence, { now? })` returns `getState()` and `command(action, stepIndex?)`; `command` returns the new public state and throws on invalid actions or `goto` indices.

- [ ] **Step 1: Add failing registry tests**

  Cover loading `{}`, persistent assignment, occupied-role theft, invalid roles, and proof that the final JSON file is valid after each awaited write. Run `node --test test/registry.test.js`; expected result is failure because `src/registry.js` does not exist.

- [ ] **Step 2: Implement the registry and verify green**

  Use a same-directory temporary file followed by `rename`, serialize writes through a promise chain, return defensive copies, and accept only non-empty device IDs plus roles `A` or `B`. Run `node --test test/registry.test.js`; expected result is all registry tests passing.

- [ ] **Step 3: Add failing sequence tests**

  Cover the supplied v1 schema, rejection of malformed sequence IDs/steps/targets/triggers, initial state, start/stop, clamped next/prev, valid goto, invalid goto, and fresh timestamps. Run `node --test test/sequence.test.js`; expected result is failure because `src/sequence.js` does not exist.

- [ ] **Step 4: Implement the sequence module and verify green**

  Public state has exactly `sequenceId`, `running`, `stepIndex`, `stepId`, `enteredAtServerMs`, and cloned `params`. `start` always selects index 0; every valid command stamps the supplied clock even at a clamp boundary. Run `node --test test/sequence.test.js`; expected result is all sequence tests passing.

### Task 2: HTTP, WebSocket, discovery, and relay server

**Files:**
- Create: `src/server.js`
- Create: `test/server.test.js`

**Interfaces:**
- `createValueArchiveServer(options?)` creates but does not start the services and returns async `start()`, async `stop()`, `address()`, and read-only `getState()`.
- Running `node src/server.js` starts HTTP/WS on `8765` and UDP on `47800`.
- Debug endpoints are `GET /api/state`, `POST /api/assign`, and `POST /api/seq`.

- [ ] **Step 1: Add failing integration tests**

  Start on ephemeral HTTP/UDP ports with temporary registry/sequence files. Assert REST state, Quest/dashboard welcome payloads (including sequence metadata for rendering), health push and online state, ping/pong RTT, role assignment/theft (including null notification to the displaced Quest), sequence broadcast, binary relay identity, role-byte mismatch/unassigned-frame rejection, request-frame/source-control forwarding, malformed-message survival, `/ws` path enforcement, and UDP discovery response. Run `node --test test/server.test.js`; expected result is failure because `src/server.js` does not exist.

- [ ] **Step 2: Implement the server and verify green**

  Enumerate and log all non-internal IPv4 addresses, select the first or fall back to `127.0.0.1`, attach `WebSocketServer` in `noServer` mode, classify sockets only after `hello`, and clear every interval/socket/server during `stop()`. Run `node --test test/server.test.js`; expected result is all server integration tests passing with no leaked handles.

- [ ] **Step 3: Verify the complete automated suite**

  Run `npm test`; expected result is zero failures across registry, sequence, and server tests.

### Task 3: Push-driven dashboard

**Files:**
- Create: `public/index.html`
- Create: `public/app.js`
- Create: `public/style.css`
- Create: `test/dashboard.test.js`

**Interfaces:**
- Dashboard sends `hello`, `assignRole`, and `seqCommand`.
- Dashboard consumes `welcome`, `deviceUpdate`, `seqState`, and role-prefixed binary JPEG frames.
- Manual frame refresh sends `requestFrame` with a role; per-role source selection sends `previewSource` with `source: "eye"|"pca"` for forwarding to the currently assigned Quest.

- [ ] **Step 1: Add failing dashboard helper/contract tests**

  Import browser-independent exports from `public/app.js` to cover WebSocket URL selection, distance/relative-time formatting, role-byte parsing, and reconnect delay. Read `public/index.html` to assert the two role-card hooks, unassigned section, sequence controls, and absence of external HTTP/CDN references. Run `node --test test/dashboard.test.js`; expected result is failure because the dashboard files do not exist.

- [ ] **Step 2: Build semantic offline HTML**

  Provide connection status, two fixed role cards, unassigned device section, sequence controls, and accessible buttons/lists without external resources.

- [ ] **Step 3: Implement WebSocket state/rendering**

  Export pure helpers before guarded browser startup, then use one socket, a fixed 2-second reconnect delay, binary `arraybuffer`, Blob URL replacement with immediate revocation of the previous URL, push-driven device/sequence rendering, delegated click handlers, and one relative-age timer.

- [ ] **Step 4: Implement responsive venue styling**

  Use locally defined dark-theme tokens, high-contrast online/offline/running badges, legible telemetry grids, responsive two-card layout, and visible focus states.

- [ ] **Step 5: Verify dashboard tests and syntax**

  Run `node --test test/dashboard.test.js` and `node --check public/app.js`; expected result is all dashboard tests passing and syntax exit code 0.

### Task 4: Mock Quest and operator documentation

**Files:**
- Create: `tools/mock-quest.js`
- Create: `README.md`
- Create: `test/mock-quest.test.js`

**Interfaces:**
- `node tools/mock-quest.js <deviceId> [--direct 127.0.0.1]` discovers or directly connects to the server.
- The mock answers ping, emits 1 Hz plausible health, begins 3-second binary JPEG frames only after a role is known, sends an immediate frame on `requestFrame`, logs sequence/role messages, reconnects after disconnect, and exits cleanly on Ctrl+C.

- [ ] **Step 1: Add failing mock-client tests**

  Import pure helpers to cover required device ID parsing, direct-mode parsing, malformed discovery responses, plausible health shape/ranges, sinusoidal nullable distances, and distinct valid JPEG buffers beginning/ending with JPEG markers. Run `node --test test/mock-quest.test.js`; expected result is failure because `tools/mock-quest.js` does not exist.

- [ ] **Step 2: Implement CLI parsing and discovery**

  Validate arguments, broadcast `VA_DISCOVER?` to UDP `47800` with a bounded timeout, parse the `VA_SERVER` JSON suffix, and construct `ws://<ip>:<port>/ws`.

- [ ] **Step 3: Implement simulation**

  Export the pure helpers used by tests; use sinusoidal distances, randomized telemetry, occasional marker dropout, embedded valid JPEG base64 constants for distinct A/B preview colors, and timer cleanup on reconnect/shutdown. Guard CLI startup so imports do not connect during tests.

- [ ] **Step 4: Write Korean operator documentation**

  Document Node.js 22 prerequisite, `npm install`, `npm start`, dashboard URL, two-mock commands, UDP/firewall notes, REST examples, role stealing, offline timing, and the no-auto-advance trigger limitation.

- [ ] **Step 5: Verify mock tests and syntax**

  Run `node --test test/mock-quest.test.js`, then enumerate every `.js` file outside `node_modules` and run `node --check` for each; expected result is all mock tests passing and exit code 0 for every syntax check.

### Task 5: End-to-end venue simulation, review, and final commit

**Files:**
- Verify all tracked project files.

- [ ] **Step 1: Install production dependencies**

  Run `npm install`; inspect `package-lock.json` and run `npm ls --depth=0`. Expected top-level production packages are only `express` and `ws`.

- [ ] **Step 2: Start the real fixed-port server and two mocks**

  Start `node src/server.js`, then start `node tools/mock-quest.js quest-alpha --direct 127.0.0.1` and `node tools/mock-quest.js quest-beta --direct 127.0.0.1`, capturing logs and process IDs.

- [ ] **Step 3: Exercise roles, telemetry, frames, and sequence**

  Use `POST /api/assign` for A/B, `POST /api/seq` for start/next/goto/stop, and `GET /api/state` to assert both devices, roles, health payloads, timestamps, and current step. Use a temporary WebSocket probe to assert welcome, device updates, sequence pushes, and binary frames from both roles.

- [ ] **Step 4: Exercise offline detection**

  Stop one mock, wait approximately 6 seconds, then assert through `GET /api/state` that it remains listed with `online:false` while the other remains online.

- [ ] **Step 5: Stop all spawned processes**

  Stop both mocks and the server in a `finally` path, then confirm no process from the verification run remains.

- [ ] **Step 6: Run final automated verification**

  Run `npm test`, syntax-check every project `.js`, validate JSON files, and inspect `git diff --check`; all commands must exit 0.

- [ ] **Step 7: Review requirement coverage and commit**

  Compare the final tree line-by-line with sections 1, 2, 4, 5, 6, and 8 of the design plus Task S1. Resolve all critical/important review findings, then run `git add -A && git commit -m "feat: build Value Archive performance server and dashboard"` and confirm `git status --short --branch` is clean on `main`.
