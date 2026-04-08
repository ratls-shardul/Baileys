# AGENTS.md

This document is the operational source of truth for agents working in this repository.

## Scope

- Keep docs and behavior aligned with the current codebase.
- Favor stability and operational safety over feature speed.
- Do not silently change message delivery guarantees.

---

## Agent Docs Location

- Store repo-specific agent markdown files in `agents/`.
- Keep one concern per file so agents stay easy to discover and maintain.
- When a new agent is added, update this section and `README.md` if the workflow is user-facing.

Current agent docs:

- `agents/testing-agent.md`: focused testing agent for API, worker, queue, and lifecycle validation
- `agents/review-agent.md`: focused review agent for correctness, regressions, and contract compliance

---

## Agent Activation

When a task explicitly mentions an agent from `agents/`, load and follow that agent’s full specification in addition to this file.

Available agents:

- `testing-agent` → `agents/testing-agent.md`
- `review-agent` → `agents/review-agent.md`

Activation rules:

- If the prompt includes:
  - "use testing-agent"
  - "testing agent"
  - "validate tests"
  - "use review-agent"
  - "review agent"
  - "review this change"
- Then you MUST:
  - Read the matching agent file in `agents/`
  - Follow its execution loop, decision rules, and constraints strictly

Agent behavior rules:

- Agent-specific rules override general heuristics
- Agents MUST NOT violate Critical Runtime Contracts defined in this file

---

## Rule Priority

1. Critical Runtime Contracts (this file)
2. Activated Agent (e.g., `testing-agent.md`)
3. General best practices

---

## System Summary

Services:

- `proxy`: Nginx TLS terminator for HTTPS/WSS origin traffic
- `worker`: Baileys socket lifecycle + outbound sender loops
- `api`: Fastify routes + websocket gateway + stream consumer
- `redis`: command/state/queue/event store
- `dashboard`: operations UI + server for container log access

Primary event path is Redis Streams (`wa:events:stream`). Pub/sub files exist but are legacy.

---

## Critical Runtime Contracts

### 1) Queue Reliability Contract

Must remain true unless explicitly approved otherwise:

1. Outbound jobs are enqueued to `wa:pending:<clientId>`.
2. Worker sender loop must not pop from queue unless client is connected.
3. Jobs remain in queue while client is uninitialized/disconnected.
4. Sending is sequential (one message at a time).
5. Random delay between sends is preserved. Runtime config may change the min/max bounds, but a fallback delay must exist if config is missing or invalid.
6. Send failure after dequeue must re-queue the job.

---

### 2) Client Lifecycle Contract

Current states in Redis hash `wa:clients:state`:

- `CREATED`, `CONNECTING`, `QR_REQUIRED`, `CONNECTED`, `DISCONNECTED`, `LOGGED_OUT`, `STOPPED`

Important transitions:

- `POST /clients/:clientId` sets up logical client and enqueues `ADD_CLIENT`
- worker startup should rehydrate non-`STOPPED`, non-`LOGGED_OUT` clients from Redis state and persisted session folders
- `401`/logout -> `LOGGED_OUT` + session clear + auto reinit
- ordinary disconnects should preserve the existing session during reconnect attempts; `405`/`408`/`428` are known transport-recoverable examples and use the slower backoff path
- repeated `DISCONNECTED` beyond retry cap -> continue reconnect attempts with the existing session; do not force session clear
- `STOP_CLIENT` -> `STOPPED` with no auto-reconnect

---

### 3) Stream Consumer Contract

`api/streamConsumer.js` must:

- consume from `wa:events:stream` consumer group
- validate payload shape before broadcast
- ack successful messages
- move poison messages to DLQ stream (`wa:events:dlq` default)
- recover stale pending with `XAUTOCLAIM`

---

## API Contracts to Preserve

- `POST /clients/:clientId`
  - validates `clientId`
  - returns `409` for existing client (no state reset)
- `GET /config/send-delay`
- `POST /config/send-delay`
  - validates `minMs`/`maxMs`
  - must preserve a safe fallback if config is absent or malformed
- `POST /messages/send`
  - validates body, file structure, and non-empty content
- Queue endpoints:
  - `GET /clients/:clientId/queue`
  - `DELETE /clients/:clientId/queue`

---

## Dashboard UX Contracts to Preserve

- No duplicate bottom "selected client actions" block.
- Client row is primary control area.
- Queue panel supports:
  - per-row queue view/clear
  - manual queue lookup by arbitrary `clientId` (including non-initialized clients)

---

## Canonical Keys

- `wa:clients:state`
- `wa:commands`
- `wa:pending:<clientId>`
- `wa:qr:<clientId>`
- `wa:clients:active`
- `wa:events:stream`
- `wa:events:dlq`
- `wa:config:sendDelay`

---

## Files to Review First Before Any Change

1. `worker/socketManager.js`
2. `worker/startupRehydrate.js`
3. `worker/mediaSender.js`
4. `api/streamConsumer.js`
5. `api/routes/clients.js`
6. `api/routes/messages.js`
7. `dashboard/src/App.jsx`
8. `api/tests/*.test.js`
9. `worker/tests/*.test.js`

---

## Change Checklist (Mandatory)

When changing queue/state/event behavior:

1. Update tests or add focused validation steps.
2. Update `README.md` and this `AGENTS.md` in same PR.
3. Document migration/rollback risk in PR description.
4. Keep changes backward-compatible unless explicitly approved.

---

## Testing Baseline

- API tests run with `cd api && npm test`.
- Worker tests run with `cd worker && npm test`.
- Current automated coverage includes:
  - API config, client, queue, and message validation routes
  - stream consumer payload validation, ack flow, and DLQ handling
  - worker disconnect handling for `401`, `405`, `408`, `428`, ordinary disconnect retries, retry-cap persistence, sender-loop requeue behavior, and startup rehydration
- Prefer adding focused tests beside the changed surface before expanding broader integration coverage.

---

## Current Known Risks (for planning)

- API/WS authentication is not implemented.
- Redis host config is hardcoded in several modules.
- Outbound queue has requeue-on-failure but no retry cap/outbound DLQ.
