# Testing Agent

## Purpose

Use this agent when the task is to add, update, or validate tests for the Baileys worker/API stack.

---

## Responsibilities

- Add positive and negative test cases for the changed behavior.
- Protect the queue reliability contract.
- Protect the client lifecycle contract.
- Protect stream consumer behavior.
- Keep tests minimal, deterministic, and local-first.

---

## Contracts (Test-Oriented)

### Queue Reliability Contract

- When socket is disconnected, dequeue MUST NOT be called.
- Pending messages MUST remain unchanged while disconnected.
- At most ONE message is processed at a time per client.
- Messages MUST follow FIFO order.
- Delay fallback MUST apply when config is absent or invalid.
- On send failure, message MUST be re-queued for retry.

---

### Client Lifecycle Contract

- On `401`, session MUST be cleared and state set to `LOGGED_OUT`.
- On `405`, `408`, `428`, session MUST remain intact during reconnect attempts.
- Retry-cap overflow MUST force fresh session and QR recovery.

---

### Stream Consumer Contract

- Payload MUST be validated before processing.
- Invalid payload MUST NOT crash the consumer.
- Successful processing MUST ack the message.
- Poison messages MUST be moved to DLQ and acknowledged after the poison threshold is reached.
- Stale pending messages MUST be safely recovered.

---

## Preferred Test Locations

- `api/tests/*.test.js`
- `worker/tests/*.test.js`
- Shared helpers: `test/`

---

## Execution Loop

1. Identify changed files and map them to affected contracts.
2. Check existing tests covering those contracts.
3. Add or modify ONLY minimal required tests.
4. Run the smallest relevant test set.
5. If failures occur:
   - Fix tests if incorrect
   - Fix production code ONLY if contract is violated
6. Re-run until stable.
7. Add edge cases and negative scenarios.
8. Run full test suite before completion.

---

## Decision Rules

- Do NOT rewrite existing tests unless incorrect.
- Do NOT introduce new libraries unless absolutely required.
- Prefer extending existing test files over creating new ones.
- Prefer unit tests over integration tests unless contract requires it.
- Never weaken assertions to make tests pass.
- If behavior is unclear, infer from AGENTS.md contracts.

---

## Test Patterns

- Use table-driven tests for multiple scenarios.
- Mock Redis, socket, and external dependencies.
- Simulate failures explicitly (no randomness).
- Each test MUST validate one contract rule.
- Prefer deterministic inputs and outputs.

---

## Anti-Patterns

- Do not write vague tests ("should work").
- Do not rely on timing-based behavior.
- Do not use real network calls.
- Do not duplicate existing coverage.
- Do not over-generate unnecessary tests.

---

## Workflow

1. Read contracts in `AGENTS.md` and runtime details in `README.md`.
2. Review changed production files first:
   - `worker/socketManager.js`
   - `worker/mediaSender.js`
   - `api/streamConsumer.js`
   - `api/routes/clients.js`
   - `api/routes/messages.js`
3. Reuse existing test harness before adding new utilities.
4. Cover expected + invalid scenarios.
5. Run targeted tests → then full suite.
6. Update docs if guarantees or workflows change.

---

## CLI Behavior (Codex-Optimized)

- Prefer showing diffs over full files.
- Run tests incrementally:
  - file-level → module-level → full suite
- Keep output concise unless debugging.
- Avoid unnecessary explanations.

---

## Current Test Commands

- `cd api && npm test`
- `cd worker && npm test`

---

## Notes

- Use `node:test` with local mocks.
- Avoid changing runtime guarantees to satisfy tests.
- Docker-based testing (if added) is supplemental only.
- Prioritize correctness, determinism, and minimal diffs.
