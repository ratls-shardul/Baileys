# AGENTS.md

This document is the operational source of truth for agents working in this repository.

## Scope

- Keep docs and behavior aligned with the current codebase.
- Favor stability and operational safety over feature speed.
- Do not silently change message delivery guarantees.

## System Summary

Services:

- `proxy`: Nginx TLS terminator for HTTPS/WSS origin traffic
- `worker`: Baileys socket lifecycle + outbound sender loops
- `api`: Fastify routes + websocket gateway + stream consumer
- `redis`: command/state/queue/event store
- `dashboard`: operations UI + server for container log access

Primary event path is Redis Streams (`wa:events:stream`). Pub/sub files exist but are legacy.

## Critical Runtime Contracts

### 1) Queue Reliability Contract

Must remain true unless explicitly approved otherwise:

1. Outbound jobs are enqueued to `wa:pending:<clientId>`.
2. Worker sender loop must not pop from queue unless client is connected.
3. Jobs remain in queue while client is uninitialized/disconnected.
4. Sending is sequential (one message at a time).
5. Random delay between sends is preserved.
6. Send failure after dequeue must re-queue the job.

### 2) Client Lifecycle Contract

Current states in Redis hash `wa:clients:state`:

- `CREATED`, `CONNECTING`, `QR_REQUIRED`, `CONNECTED`, `DISCONNECTED`, `LOGGED_OUT`, `STOPPED`

Important transitions:

- `POST /clients/:clientId` sets up logical client and enqueues `ADD_CLIENT`
- `401`/logout -> `LOGGED_OUT` + session clear + auto reinit
- `405`/`408`/`428` disconnects are treated as recoverable and should preserve the existing session during reconnect attempts
- repeated `DISCONNECTED` beyond retry cap -> force session clear + auto reinit for fresh QR
- `STOP_CLIENT` -> `STOPPED` with no auto-reconnect

### 3) Stream Consumer Contract

`api/streamConsumer.js` must:

- consume from `wa:events:stream` consumer group
- validate payload shape before broadcast
- ack successful messages
- move poison messages to DLQ stream (`wa:events:dlq` default)
- recover stale pending with `XAUTOCLAIM`

## API Contracts to Preserve

- `POST /clients/:clientId`
  - validates `clientId`
  - returns `409` for existing client (no state reset)
- `POST /messages/send`
  - validates body, file structure, and non-empty content
- Queue endpoints:
  - `GET /clients/:clientId/queue`
  - `DELETE /clients/:clientId/queue`

## Dashboard UX Contracts to Preserve

- No duplicate bottom "selected client actions" block.
- Client row is primary control area.
- Queue panel supports:
  - per-row queue view/clear
  - manual queue lookup by arbitrary `clientId` (including non-initialized clients)

## Canonical Keys

- `wa:clients:state`
- `wa:commands`
- `wa:pending:<clientId>`
- `wa:qr:<clientId>`
- `wa:clients:active`
- `wa:events:stream`
- `wa:events:dlq`

## Legacy/Non-Primary Paths

- `worker/old-socketManager.js`
- `api/redisSubscriber.js`

Do not wire these back into main flow unless explicitly requested.

## Files to Review First Before Any Change

1. `worker/socketManager.js`
2. `worker/mediaSender.js`
3. `api/streamConsumer.js`
4. `api/routes/clients.js`
5. `api/routes/messages.js`
6. `dashboard/src/App.jsx`

## Change Checklist (Mandatory)

When changing queue/state/event behavior:

1. Update tests or add focused validation steps.
2. Update `README.md` and this `AGENTS.md` in same PR.
3. Document migration/rollback risk in PR description.
4. Keep changes backward-compatible unless explicitly approved.

## Current Known Risks (for planning)

- API/WS authentication is not implemented.
- Redis persistence is disabled in compose defaults.
- Redis host config is hardcoded in several modules.
- Outbound queue has requeue-on-failure but no retry cap/outbound DLQ.
