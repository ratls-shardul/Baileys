# Baileys WhatsApp Worker + API

Redis-orchestrated WhatsApp backend built around Baileys, Fastify, and a small operations dashboard.

This README is intended to be enough to understand the codebase before making changes. It documents the actual runtime model, data contracts, operational defaults, and the files that own each behavior.

## 1) What This Repo Does

The system manages multiple WhatsApp clients identified by `clientId`.

For each client, the platform can:

- create and initialize a Baileys session
- surface QR codes and state changes in realtime
- queue outbound text/media messages in Redis
- send queued jobs only while the client is connected
- restart, stop, reconnect, or delete clients
- inspect queues and logs from the dashboard

The architecture is deliberately split into control-plane and execution-plane services:

- `api`: accepts HTTP/WebSocket requests and writes commands/queue items into Redis
- `worker`: owns Baileys sockets and drains outbound queues
- `redis`: shared system state, command bus, queue store, QR cache, and event stream
- `dashboard`: operational UI plus authenticated log viewer
- `proxy`: Nginx TLS terminator in front of the API

## 2) Mental Model

Think of the codebase in terms of three flows:

1. Client lifecycle flow
   API writes a command -> worker starts or mutates a socket -> worker writes state + events -> API broadcasts to subscribed WebSocket clients.

2. Outbound message flow
   API validates input -> API enqueues into `wa:pending:<clientId>` -> worker sender loop waits until that client is connected -> worker dequeues one job at a time and sends it.

3. Realtime flow
   Worker publishes status/QR events to Redis Stream `wa:events:stream` -> API stream consumer validates and acknowledges them -> API broadcasts them through `wsHub` to client-specific WebSocket subscribers.

## 3) Repository Structure

```text
.
├── AGENTS.md
├── README.md
├── docker-compose.yaml
├── nginx/
│   ├── certs/
│   └── conf.d/default.conf
├── api/
│   ├── index.js
│   ├── logger.js
│   ├── redis.js
│   ├── streamConsumer.js
│   ├── wsHub.js
│   ├── routes/
│   │   ├── clients.js
│   │   ├── debug-routes.js
│   │   ├── messages.js
│   │   └── ws.js
│   └── tests/
├── worker/
│   ├── index.js
│   ├── commandListener.js
│   ├── clientState.js
│   ├── logger.js
│   ├── mediaSender.js
│   ├── sessionUtils.js
│   ├── socketManager.js
│   └── tests/
├── dashboard/
│   ├── server/index.js
│   └── src/App.jsx
├── logs/
└── sessions/
```

## 4) Service Responsibilities

### 4.1 `worker`

Primary files:

- `worker/index.js`
- `worker/startupRehydrate.js`
- `worker/commandListener.js`
- `worker/socketManager.js`
- `worker/mediaSender.js`

Responsibilities:

- listen on Redis list `wa:commands`
- initialize one Baileys socket per `clientId`
- track connection lifecycle and Redis client state
- publish QR/status events into `wa:events:stream`
- maintain sender loops for outbound jobs
- clear session files when required

Important implementation details:

- session files are stored under `/sessions/<clientId>`
- state is written to Redis hash `wa:clients:state`
- active worker-owned sockets are mirrored in Redis set `wa:clients:active`
- worker startup rehydrates clients from Redis state plus persisted `/sessions` folders, skipping `STOPPED` and `LOGGED_OUT`
- one dedicated Redis connection is used per sender loop because `BRPOP` is blocking
- a separate Redis publisher connection is used for stream publishing to reduce interference with other worker operations

### 4.2 `api`

Primary files:

- `api/index.js`
- `api/routes/clients.js`
- `api/routes/messages.js`
- `api/routes/ws.js`
- `api/routes/debug-routes.js`
- `api/streamConsumer.js`
- `api/wsHub.js`

Responsibilities:

- expose REST endpoints for client lifecycle and message enqueueing
- expose `GET /ws` for realtime client-specific updates
- read QR/state snapshots from Redis for newly registered sockets
- consume worker events from `wa:events:stream`
- broadcast valid events to interested WebSocket clients

Important implementation details:

- CORS is currently permissive: `origin: true`
- Redis host defaults to `redis`
- the API starts the stream consumer during process startup

### 4.3 `dashboard`

Primary files:

- `dashboard/server/index.js`
- `dashboard/src/App.jsx`

Responsibilities:

- authenticated operations UI on port `8080`
- client lifecycle buttons
- queue view/clear tools
- send-delay configuration UI
- basic message enqueue form
- container log viewer through Docker socket access

Important implementation details:

- dashboard auth is HTTP Basic Auth
- defaults are `DASH_USER=admin`, `DASH_PASS=admin` in code
- compose overrides `DASH_PASS` to `change-me`
- log access depends on mounting `/var/run/docker.sock`

### 4.4 `proxy`

Purpose:

- terminates TLS for HTTPS and WSS
- forwards traffic to the API service

The API itself stays on internal Docker port `3000`; external HTTPS/WSS should go through Nginx on `443`.

## 5) Redis Data Model

These keys are the runtime contracts the rest of the code assumes:

- `wa:clients:state`
  Redis hash of `clientId -> state`

- `wa:commands`
  Redis list used as a worker command queue

- `wa:pending:<clientId>`
  Redis list containing outbound jobs for one client

- `wa:qr:<clientId>`
  Redis string holding the latest QR payload, TTL 120 seconds

- `wa:clients:active`
  Redis set of worker-initialized active sockets

- `wa:events:stream`
  Redis stream carrying QR/status/test events from worker or debug routes

- `wa:events:dlq`
  Redis stream used by the API stream consumer for poison messages

- `wa:config:sendDelay`
  Redis JSON string with runtime send-delay config:
  `{ "minMs": number, "maxMs": number }`

## 6) Client States

The worker and API currently operate on these states:

- `CREATED`
- `CONNECTING`
- `QR_REQUIRED`
- `CONNECTED`
- `DISCONNECTED`
- `LOGGED_OUT`
- `STOPPED`

Special note:

- `DELETE_CLIENT` removes the client from `wa:clients:state`, clears queue and QR keys, clears the session directory, and publishes a `DELETED` status event. `DELETED` is an event state, not a persisted hash state.

## 7) Command Flow

Worker control is command-driven through `wa:commands`.

Command payloads:

- `ADD_CLIENT`
- `RESTART_CLIENT`
- `STOP_CLIENT`
- `DELETE_CLIENT`

Who writes commands:

- `POST /clients/:clientId` -> `ADD_CLIENT`
- `POST /clients/:clientId/reconnect` -> `ADD_CLIENT`
- `POST /clients/:clientId/restart` -> `RESTART_CLIENT`
- `POST /clients/:clientId/stop` -> `STOP_CLIENT`
- `DELETE /clients/:clientId` -> `DELETE_CLIENT`

Who consumes commands:

- `worker/commandListener.js` blocks on `BRPOP wa:commands`
- the listener dispatches each command into `socketManager`

## 8) Actual Client Lifecycle

This section mirrors `worker/socketManager.js`.

### 8.1 Create and initialize

1. `POST /clients/:clientId` validates the `clientId`.
2. API returns `409` if the client already exists in `wa:clients:state`.
3. API writes `CREATED` into `wa:clients:state`.
4. API enqueues `{ type: "ADD_CLIENT", clientId }` into `wa:commands`.
5. Worker receives the command and calls `initClient(clientId)`.
6. Worker sets state to `CONNECTING`.
7. Worker loads or creates auth state from `/sessions/<clientId>`.
8. Worker fetches the latest Baileys WhatsApp version at startup of that socket.

### 8.1.1 Worker startup rehydration

On worker process startup:

- the worker reads `wa:clients:state`
- the worker scans `/sessions` for persisted session folders
- it builds the union of those client IDs
- it skips clients currently marked `STOPPED` or `LOGGED_OUT`
- it calls `initClient()` for the remaining clients

This allows sockets to come back after worker or Redis restarts without requiring a manual dashboard restart for each client.

### 8.2 QR issuance

When Baileys emits a QR:

- worker sets state `QR_REQUIRED`
- worker stores QR at `wa:qr:<clientId>` with TTL 120 seconds
- worker publishes `{ type: "qr", clientId, qr }` to `wa:events:stream`
- the publish is retried once if the first attempt fails

### 8.3 Open connection

When Baileys reports `connection === "open"`:

- worker clears reconnect counters
- worker sets state `CONNECTED`
- worker deletes `wa:qr:<clientId>`
- worker publishes a `status` event with state `CONNECTED`
- worker adds the client to `connectedClients`
- worker starts the sender loop after a 2 second delay

### 8.4 Logged out / unauthorized

On `401` or `DisconnectReason.loggedOut`:

- worker sets state `LOGGED_OUT`
- worker publishes a `LOGGED_OUT` status event
- worker removes the socket
- worker removes the client from `wa:clients:active`
- worker clears the session directory
- worker automatically reinitializes after 1.5 seconds so a fresh QR can be generated

### 8.5 Post-login restart required

Baileys often emits `515` immediately after a fresh login. The code treats this as expected handover when it happens shortly after `isNewLogin`.

Behavior:

- state is set to `CONNECTING`
- a `CONNECTING` status event is published
- the socket is restarted without clearing session files
- reinitialization happens after 1.5 seconds

### 8.6 Recoverable disconnects

The worker preserves the existing auth session for reconnect attempts unless the client explicitly logged out (`401`) or the retry cap is exceeded. Status codes `405`, `408`, and `428` are treated as known transport-level recoverable disconnects.

Behavior:

- state becomes `DISCONNECTED`
- a `DISCONNECTED` status event is published
- the session is preserved
- reconnect delay is `min(15000 * attempt, 120000)` milliseconds

This avoids unnecessary QR churn during transient failures.

### 8.7 Other disconnects

For other disconnects:

- state becomes `DISCONNECTED`
- a `DISCONNECTED` status event is published
- the session is preserved
- reconnect delay is `min(3000 * attempt, 30000)` milliseconds

### 8.8 Retry cap

If reconnect attempts exceed 8:

- the worker keeps the existing session
- the state remains in the disconnect/retry path
- reconnect attempts continue with capped backoff
- no QR reset is forced purely because the retry counter grew

### 8.9 Stop, restart, delete

`restartClient(clientId, { resetSession })`

- stops sender loop
- drops current socket
- optionally clears session
- sets state `CONNECTING`
- publishes `CONNECTING`
- immediately calls `initClient`

`stopClient(clientId, { resetSession })`

- marks client as stopped
- stops sender loop
- drops current socket
- optionally clears session
- sets state `STOPPED`
- publishes `STOPPED`
- does not auto-reconnect

`deleteClient(clientId)`

- marks client as stopped
- stops sender loop
- drops current socket
- deletes `wa:qr:<clientId>`
- deletes `wa:pending:<clientId>`
- removes the client from `wa:clients:state`
- clears session files
- publishes a `DELETED` status event

## 9) Outbound Queue Contract

This is the most important behavioral contract in the system.

### 9.1 Enqueue behavior

`POST /messages/send` does not send directly. It only validates and enqueues.

The API writes this shape into `wa:pending:<clientId>`:

```json
{
  "type": "SEND_MESSAGE",
  "clientId": "client-1",
  "phoneNumber": "9999999999",
  "text": "hello",
  "files": []
}
```

Validation rules in `api/routes/messages.js`:

- `clientId` must be a non-empty string
- `phoneNumber` must be present
- `files` must be an array
- every file must contain non-empty `file_url` and `mimeType`
- at least one of `text` or `files[]` must be present
- text is trimmed before enqueueing

### 9.2 Dequeue behavior

The worker sender loop in `worker/socketManager.js`:

- starts only once per client
- does not dequeue anything while the client is disconnected or missing
- blocks on `BRPOP wa:pending:<clientId>` only when the socket is present and marked connected
- processes one queue item at a time

This means messages can safely be queued before a client has ever connected.

### 9.3 Retry behavior

If sending fails after dequeue:

- the raw job is pushed back to the same queue using `RPUSH`
- the worker sleeps for 3 seconds
- the item is retried later

The queue currently has:

- requeue-on-failure
- no explicit retry counter
- no outbound DLQ

### 9.4 Send-delay behavior

Runtime delay config is read from `wa:config:sendDelay`.

Normalization rules used by both API and worker:

- minimum allowed delay: `500ms`
- maximum allowed delay: `120000ms`
- if config is missing, malformed, or invalid, fallback is `3000-8000ms`

After each successful send, the worker sleeps for a random value between `minMs` and `maxMs`.

### 9.5 Queue ordering note

The code currently uses:

- `LPUSH` when enqueueing
- `BRPOP` when consuming

That gives FIFO behavior for newly queued jobs. Failed sends are reinserted with `RPUSH`, which keeps the failed item as the next item retried for that client.

## 10) Media Send Behavior

Implemented in `worker/mediaSender.js`.

Rules:

- text-only payloads send as `{ text }`
- one image or video can carry the text as a caption
- one document or audio file is sent first; if text exists and cannot be captioned, text is sent as a second message
- multiple files are sent one-by-one, then trailing text is sent afterward

Media type handling:

- `image/*` -> `image`
- `video/*` -> `video`
- `audio/*` -> `audio`
- everything else -> `document`

Validation safeguards:

- missing or invalid `file_url` throws an error before send

Phone normalization detail:

- sender loop converts a bare phone number into `91<phone>@s.whatsapp.net`
- if the phone already contains `@s.whatsapp.net`, it is used as-is

This is an important implementation assumption: the current worker defaults bare numbers to the India country code `91`.

## 11) Realtime Event Flow

### 11.1 Worker publishes

Worker publishes events to Redis Stream `wa:events:stream` as:

- stream fields: `data`, `JSON.stringify(event)`

Common event shapes:

- `{ type: "qr", clientId, qr }`
- `{ type: "status", clientId, state }`
- `{ type: "test", clientId, message, timestamp }`

### 11.2 API consumes

`api/streamConsumer.js`:

- uses consumer group `api-consumers`
- uses a unique consumer name per process
- creates the group with `MKSTREAM` if needed
- processes own pending entries first
- then runs `XAUTOCLAIM` recovery for stale pending entries
- then blocks for new entries

### 11.3 Validation and ack

An event is considered valid only if:

- the stream message contains a `data` field
- `data` parses as JSON
- the parsed object contains both `clientId` and `type`

Successful processing:

- broadcast through `wsHub`
- `XACK` the message

Failed processing:

- failure count is tracked in-memory per message ID
- after `WA_EVENTS_POISON_THRESHOLD` attempts, message is copied to DLQ
- the original message is then acknowledged

Default stream consumer environment knobs:

- `WA_EVENTS_DLQ_STREAM=wa:events:dlq`
- `WA_EVENTS_POISON_THRESHOLD=5`
- `WA_EVENTS_AUTOCLAIM_MIN_IDLE_MS=60000`
- `WA_EVENTS_AUTOCLAIM_BATCH_SIZE=50`

Important limitation:

- poison attempt counters are in-memory, so they reset if the API process restarts

## 12) WebSocket Model

Implemented by:

- `api/routes/ws.js`
- `api/wsHub.js`

Behavior:

- WebSocket endpoint is `GET /ws`
- the first inbound message must include `clientId`
- first message may be a normal message or a ping
- once registered, the socket is associated with that `clientId`
- registration triggers an immediate snapshot push:
  - current status from `wa:clients:state`
  - current QR from `wa:qr:<clientId>`, if present

Ping handling:

```json
{ "clientId": "client-1", "type": "ping" }
```

Pong reply:

```json
{ "type": "pong", "timestamp": 1710000000000 }
```

Broadcast model:

- `wsHub` stores `clientId -> Set<WebSocket>`
- broadcasts go only to sockets registered for that same `clientId`
- sockets are removed from the registry on `close`

## 13) REST API

### 13.1 Health

- `GET /health`
  - returns `{ status: "ok" }`

### 13.2 Client lifecycle

- `GET /clients`
  - returns raw `wa:clients:state` hash

- `POST /clients/:clientId`
  - validates `clientId` with `^[a-zA-Z0-9._:-]{1,120}$`
  - returns `409` if client already exists
  - writes `CREATED` and queues `ADD_CLIENT`

- `POST /clients/:clientId/reconnect`
  - allowed only from `LOGGED_OUT`, `DISCONNECTED`, or `STOPPED`
  - queues `ADD_CLIENT`

- `POST /clients/:clientId/restart`
  - body: `{ resetSession?: boolean }`
  - queues `RESTART_CLIENT`

- `POST /clients/:clientId/stop`
  - body: `{ resetSession?: boolean }`
  - queues `STOP_CLIENT`

- `DELETE /clients/:clientId`
  - queues `DELETE_CLIENT`

- `GET /clients/:clientId/status`
  - returns `{ state: "<STATE>" }` if known
  - returns `{ clientId, state: "NON_EXISTENT" }` if missing

### 13.3 Send-delay config

- `GET /config/send-delay`
  - returns active config and source:
    `{ minMs, maxMs, source: "default" | "redis" }`

- `POST /config/send-delay`
  - body: `{ minMs, maxMs }`
  - validates integer bounds
  - returns `400` on invalid ranges
  - stores normalized values in Redis

### 13.4 Queue

- `POST /messages/send`
  - validates and enqueues outbound jobs

- `GET /clients/:clientId/queue?limit=<1..200>`
  - returns:
    - `clientId`
    - `total`
    - `returned`
    - `limit`
    - `messages`
  - each `messages[]` row includes:
    - `index`
    - `raw`
    - `parsed` or `null`

- `DELETE /clients/:clientId/queue`
  - deletes the Redis list for that client
  - returns how many items were cleared

### 13.5 Debug

- `GET /debug/ws-stats`
- `GET /debug/client-states`
- `GET /debug/active-clients`
- `POST /debug/test-broadcast/:clientId`
- `GET /debug/qr/:clientId`
- `GET /debug/pending/:clientId`

These endpoints are operational/debug tooling, not hardened admin APIs.

## 14) Dashboard Behavior

The React dashboard in `dashboard/src/App.jsx` is a polling admin UI with queue tools and log access.

It currently supports:

- manual API base URL entry, stored in localStorage
- client creation
- reconnect, restart, reset+restart
- stop, reset+stop
- delete
- queue inspection for known clients
- manual queue lookup by arbitrary `clientId`
- queue clear by row action or manual lookup
- send-delay view/edit
- simple text-message enqueue form
- overview counters:
  - known clients
  - active sockets
  - websocket connections
- log tailing for `worker`, `api`, `redis`, `dashboard`

Polling behavior:

- refreshes debug data every 5 seconds

Operational UX contract already assumed in the repo:

- client row is the primary control area
- no duplicate bottom action block
- queue panel supports arbitrary `clientId` lookup, even for clients not created yet

## 15) Docker Compose Defaults

Current `docker-compose.yaml` defines:

- `redis`
- `worker`
- `api`
- `proxy`
- `dashboard`

Defaults worth knowing:

- Redis persistence is enabled with:
  - `--save 60 1000`
  - `--appendonly yes`
  - `--appendfsync everysec`
- Redis data is stored in the named Docker volume `redis-data`
- worker mounts:
  - `./sessions:/sessions`
  - `./logs:/logs`
- dashboard mounts:
  - `/var/run/docker.sock:/var/run/docker.sock`
- external ports:
  - `6379` for Redis
  - `443` for Nginx proxy
  - `8080` for dashboard

Current compose environment highlights:

- worker:
  - `WA_DEVICE_NAME`
  - `WA_DEVICE_PLATFORM`
  - `WA_DEVICE_VERSION`
  - `LOG_LEVEL`
  - `CLIENT_LOG_LEVEL`
  - `LOG_CLIENTS_DIR`
  - `SCRUB_SIGNAL_LOGS`

- api:
  - `LOG_LEVEL`
  - `API_LOG_LEVEL`

- dashboard:
  - `DASH_USER`
  - `DASH_PASS`
  - `DASH_PORT`

## 16) TLS / Proxy Setup

The proxy expects these files:

- `nginx/certs/origin.crt`
- `nginx/certs/origin.key`

Recommended permissions:

```bash
chmod 600 nginx/certs/origin.key
chmod 644 nginx/certs/origin.crt
```

Typical restart after cert updates:

```bash
docker compose up -d --force-recreate proxy api
```

## 17) Testing Surface

Current automated tests live in:

- `api/tests/clients.routes.test.js`
- `api/tests/messages.routes.test.js`
- `api/tests/streamConsumer.test.js`
- `worker/tests/socketManager.test.js`
- `worker/tests/startupRehydrate.test.js`

What is covered today:

- send-delay defaults, normalization, and validation
- client creation and duplicate handling
- reconnect state gatekeeping
- queue inspection and clearing endpoints
- message enqueue validation
- stream message validation, ack, and DLQ handling
- disconnect handling for `401`, `405`, `408`, `428`, ordinary disconnect retries, retry-cap session persistence, and sender-loop requeue behavior
- worker startup rehydration from Redis state and session folders
- sender-loop requeue-on-send-failure behavior

How to run tests:

```bash
cd api && npm test
```

```bash
cd worker && npm test
```

## 18) Files To Read Before Changing Behavior

If you are changing lifecycle, queues, or realtime behavior, read these first:

1. `worker/socketManager.js`
2. `worker/startupRehydrate.js`
3. `worker/mediaSender.js`
4. `api/streamConsumer.js`
5. `api/routes/clients.js`
6. `api/routes/messages.js`
7. `api/routes/ws.js`
8. `api/wsHub.js`
9. `dashboard/src/App.jsx`
10. `api/tests/*.test.js`
11. `worker/tests/*.test.js`

## 19) Known Gaps and Risks

These are current realities, not future tasks:

- API and WebSocket endpoints are unauthenticated
- API CORS is permissive
- Redis host is hardcoded to `redis` in several modules
- outbound queue has no retry counter and no outbound DLQ
- poison message tracking in the stream consumer is in-memory only
- bare phone numbers are normalized to India prefix `91`

## 20) Common Operations

Create a client:

```bash
curl -k -X POST https://localhost/clients/client-1
```

Queue a text message:

```bash
curl -k -X POST https://localhost/messages/send \
  -H "content-type: application/json" \
  -d '{"clientId":"client-1","phoneNumber":"9999999999","text":"hello"}'
```

Check client status:

```bash
curl -k https://localhost/clients/client-1/status
```

View queue:

```bash
curl -k "https://localhost/clients/client-1/queue?limit=20"
```

Clear queue:

```bash
curl -k -X DELETE "https://localhost/clients/client-1/queue"
```

## 21) Change Rules For Future Work

If you change queue, state, or event behavior:

- update focused tests in the same change
- keep this README aligned with the code
- do not silently change the dequeue-while-disconnected contract
- do not silently remove requeue-on-send-failure behavior
- do not silently alter reconnect semantics for `401`, ordinary disconnect retries, `405`, `408`, `428`, or retry-cap session persistence

This repository relies on those behaviors operationally.
