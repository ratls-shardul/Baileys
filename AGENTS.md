# AGENTS.md

This file captures the current working rules and system behavior for the Baileys project.

## Project Snapshot

- Services:
  - `worker` (Baileys socket manager + sender loop)
  - `api` (Fastify REST + WebSocket + Redis stream consumer)
  - `dashboard` (React UI + Express server)
  - `redis` (command/state/event bus)
- Main event pipeline: Redis Streams (`wa:events:stream`), not pub/sub.

## Canonical Redis Keys

- `wa:clients:state` (hash): logical client state
- `wa:commands` (list): control commands for worker
- `wa:pending:<clientId>` (list): outbound queue per client
- `wa:qr:<clientId>` (string): latest QR
- `wa:events:stream` (stream): worker -> API events
- `wa:events:dlq` (stream): poison events from API consumer

## Queue Delivery Contract (Important)

Current expected behavior:

1. API enqueues outbound jobs into `wa:pending:<clientId>`.
2. Worker sender loop **must not dequeue** while client is not connected.
3. Messages remain queued until socket exists and client is connected.
4. Sending is one-by-one with random delay between successful sends.
5. If send fails after dequeue, message is re-queued for retry.

Do not change this behavior without explicit approval.

## Media Sending Rules

- `image/*` and `video/*` are caption-capable.
- `application/pdf` and other documents are sent as document + separate text message.
- Invalid media payload should fail safely (no process crash).

## API Stability Rules

- `POST /clients/:clientId` is idempotency-protected:
  - invalid `clientId` -> `400`
  - existing client -> `409` (do not reset state)
- `POST /messages/send` validates body and file shape.
- Stream consumer:
  - validates event structure
  - tracks failures
  - moves poison events to DLQ
  - uses `XAUTOCLAIM` to recover stale pending entries from dead consumers

## Dashboard Operational Rules

- No duplicate “selected client” action section at bottom.
- Client row actions are primary control surface.
- Queue operations supported:
  - view queue per listed client
  - clear queue per listed client
  - manual queue lookup/clear by entering any `clientId`
    - includes clients not initialized or not visible in state list

## Files To Read First

1. `worker/socketManager.js`
2. `worker/mediaSender.js`
3. `api/streamConsumer.js`
4. `api/routes/clients.js`
5. `api/routes/messages.js`
6. `dashboard/src/App.jsx`

## Change Discipline

- Keep queue reliability guarantees intact.
- Prefer additive, backward-compatible API changes.
- Avoid introducing alternate event path (pub/sub) unless explicitly requested.
- If changing queue/state semantics, update:
  - `README.md`
  - this `AGENTS.md`
  - dashboard UX (if operator flow changes)

