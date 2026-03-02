# Baileys WhatsApp Worker + API (Redis-Orchestrated)

This repository is a containerized WhatsApp messaging backend built around:

- A **worker** service that runs Baileys sockets (one socket per client ID).
- An **API** service (Fastify) that exposes HTTP + WebSocket interfaces.
- **Redis** as the shared command/state/event bus.

The system supports:

- Creating logical WhatsApp clients.
- QR-based login flow.
- Real-time status/QR updates over WebSocket.
- Queued outbound text/media message sending.
- Session persistence on disk (`./sessions` volume).

---

## 1) Repository Structure

```text
.
├── api
│   ├── Dockerfile
│   ├── index.js
│   ├── package.json
│   ├── redis.js
│   ├── redisSubscriber.js
│   ├── streamConsumer.js
│   ├── wsHub.js
│   └── routes
│       ├── clients.js
│       ├── debug-routes.js
│       ├── messages.js
│       └── ws.js
├── worker
│   ├── Dockerfile
│   ├── index.js
│   ├── package.json
│   ├── commandListener.js
│   ├── socketManager.js
│   ├── old-socketManager.js
│   ├── sessionUtils.js
│   ├── clientState.js
│   ├── mediaSender.js
│   └── utils
│       └── delay.js
├── docker-compose.yaml
└── README.md
```

---

## 2) High-Level Architecture

```text
HTTP Client / Frontend
   │
   ├── REST calls ───────────────► API (Fastify)
   │                                │
   │                                ├── writes commands / queues to Redis
   │                                ├── reads client state + QR from Redis
   │                                └── WebSocket endpoint for realtime updates
   │
   └── WebSocket (/ws) ◄────────── API wsHub broadcast
                                     ▲
                                     │
Redis Streams (wa:events:stream) ◄── Worker publishes QR/status events
                                     │
Redis Lists / Hash / KV   ◄────────── Worker + API share state and queues
                                     │
                                     ▼
                             Worker (Baileys socket manager)
                             ├── init/reconnect clients
                             ├── login/QR lifecycle
                             └── send queued messages
```

---

## 3) Runtime Components

### 3.1 `worker` service

Main entrypoint: `worker/index.js`

- Starts Redis command listener (`startCommandListener`).
- Keeps process alive with dummy interval.
- Core logic lives in `worker/socketManager.js`.

Responsibilities:

- Consume control commands (`wa:commands`) for new client creation.
- Manage one Baileys socket per `clientId`.
- Persist auth/session files in `/sessions/<clientId>`.
- Track and write lifecycle state to Redis hash.
- Publish events to Redis Stream (`wa:events:stream`).
- Run per-client sender loops consuming `wa:pending:<clientId>`.

### 3.2 `api` service

Main entrypoint: `api/index.js`

- Registers:
  - `@fastify/websocket`
  - `@fastify/cors` (`origin: true`)
  - routes: `ws`, `clients`, `messages`, `debug-routes`
- Starts Redis Stream consumer (`startConsumer` from `streamConsumer.js`).
- Exposes `/health`.

Responsibilities:

- REST API for client lifecycle and message queueing.
- WebSocket registration and delivery fanout via in-memory `wsHub`.
- Consume stream events and broadcast to connected WebSocket clients.

### 3.3 `redis` service

From `docker-compose.yaml`:

- Image: `redis:7-alpine`
- In-memory oriented config:
  - `--appendonly no`
  - `--save ""`
  - `--maxmemory 256mb`
  - eviction `allkeys-lru`
- Port mapping: `6379:6379`

Implication: Redis is effectively ephemeral unless external persistence is added.

---

## 4) Redis Data Model and Contracts

### 4.1 Keys in use

- `wa:clients:state` (Hash)
  - field: `clientId`
  - value: one of `CREATED | CONNECTING | QR_REQUIRED | CONNECTED | DISCONNECTED | LOGGED_OUT`

- `wa:commands` (List)
  - queue of control commands consumed by worker command listener.
  - currently used for `ADD_CLIENT`.

- `wa:pending:<clientId>` (List)
  - outbound message jobs consumed by worker sender loop.

- `wa:qr:<clientId>` (String, TTL 120s)
  - latest QR payload for login.

- `wa:events:stream` (Redis Stream)
  - event feed from worker -> API stream consumer.
  - stream entry field: `data` containing JSON event.

### 4.2 Event payload shape (stream)

Observed event types:

- QR event:
  - `{ "type": "qr", "clientId": "...", "qr": "..." }`
- Status event:
  - `{ "type": "status", "clientId": "...", "state": "CONNECTED|DISCONNECTED|LOGGED_OUT" }`

---

## 5) Detailed Flows

### 5.1 Client creation and QR flow

1. Client calls `POST /clients/:clientId`.
2. API:
   - sets `wa:clients:state[clientId] = CREATED`.
   - pushes `{ type: "ADD_CLIENT", clientId }` to `wa:commands`.
3. Worker command listener BRPOPs `wa:commands`, calls `initClient(clientId)`.
4. Worker sets state to `CONNECTING`, starts Baileys socket.
5. When Baileys emits `qr`:
   - worker sets state `QR_REQUIRED`.
   - stores QR in `wa:qr:<clientId>` (TTL 120s).
   - publishes QR event into `wa:events:stream`.
6. API stream consumer reads the stream entry and broadcasts to all WS connections registered under that `clientId`.
7. Frontend receives QR payload on WebSocket.

### 5.2 Successful connection flow

1. Baileys emits `connection = "open"`.
2. Worker:
   - sets state `CONNECTED`.
   - deletes `wa:qr:<clientId>`.
   - publishes status event `{ state: "CONNECTED" }`.
   - starts per-client sender loop after 2s.
3. API stream consumer broadcasts status to WS subscribers.

### 5.3 Logged-out flow

1. Baileys closes with status `DisconnectReason.loggedOut` or `401`.
2. Worker:
   - sets state `LOGGED_OUT`.
   - publishes LOGGED_OUT status event.
   - removes listeners, ends socket, deletes from map.
   - clears `/sessions/<clientId>` directory.
   - auto-reinitializes after a short delay so a new QR can be generated for the same client.

### 5.4 Transient disconnect flow

1. Baileys closes for other reasons.
2. Worker:
   - handles disconnect by status code:
     - `515` immediately after `isNewLogin` is treated as expected "restart required":
       - state published as `CONNECTING` (not `DISCONNECTED`)
       - socket is restarted without clearing session
     - `405` connection failures:
       - publishes `DISCONNECTED`
       - preserves session
       - retries with backoff and capped attempts
     - other non-logout disconnects:
       - publishes `DISCONNECTED`
       - clears session and retries with backoff

### 5.5 Reconnect endpoint behavior

- `POST /clients/:clientId/reconnect` is allowed when current state is:
  - `LOGGED_OUT`
  - `DISCONNECTED`

### 5.6 Outbound message flow

1. Client calls `POST /messages/send` with:
   - `clientId`, `phoneNumber`, optional `text`, optional `files[]`.
2. API pushes a SEND_MESSAGE payload directly into `wa:pending:<clientId>`.
3. Worker sender loop (`BRPOP wa:pending:<clientId>`) receives job.
4. Worker resolves recipient JID:
   - if already in `*@s.whatsapp.net` format, uses as-is.
   - else prepends hardcoded country code `91` and appends `@s.whatsapp.net`.
5. Worker sends via `sendMessageWithMedia`.
6. Worker sleeps random 2-5 seconds before next send.

---

## 6) API Surface

### 6.1 Health

- `GET /health`
  - Returns `{ status: "ok" }`

### 6.2 Client endpoints

- `GET /clients`
  - Returns all entries from `wa:clients:state`.

- `POST /clients/:clientId`
  - Initializes logical client.
  - Returns `{ ok: true, clientId }`.

- `POST /clients/:clientId/reconnect`
  - Allowed when state is `LOGGED_OUT` or `DISCONNECTED`.
  - Requeues `ADD_CLIENT`.

- `GET /clients/:clientId/status`
  - Returns `{ state }` or `{ clientId, state: "NON_EXISTENT" }`.

### 6.3 Message endpoint

- `POST /messages/send`
  - Required: `clientId`, `phoneNumber`
  - At least one of: `text` or non-empty `files`.
  - Enqueues payload into per-client pending list.
  - Returns `{ ok: true, queued: true }`.

### 6.4 WebSocket endpoint

- `GET /ws` (websocket upgrade)
- Expected inbound messages from frontend:
  - At minimum: `{ "clientId": "..." }`
  - Ping form: `{ "clientId": "...", "type": "ping" }`
- Server behavior:
  - Registers socket to `clientId` on first message containing `clientId` (including ping).
  - Immediately sends current status event.
  - Sends QR event if `wa:qr:<clientId>` exists.
  - Replies to ping with `{ "type": "pong", "timestamp": <ms> }`.

### 6.5 Debug endpoints

- `GET /debug/ws-stats`
- `GET /debug/client-states`
- `POST /debug/test-broadcast/:clientId`
- `GET /debug/qr/:clientId`
- `GET /debug/pending/:clientId`

`/debug/test-broadcast/:clientId` now writes test events into `wa:events:stream` using `XADD`.

---

## 7) WebSocket Fanout Internals (`api/wsHub.js`)

- Maintains `Map<clientId, Set<ws>>`.
- `register(clientId, ws)` adds socket and sets close handler for cleanup.
- `broadcast(clientId, payload)` JSON serializes payload and sends to all open sockets (`readyState === 1`).
- `unregister` cleans stale sockets and removes empty client entries.
- `getStats` returns socket counts by `clientId`.

This is in-memory only, so scaling API replicas requires shared pub/sub/fanout strategy.

---

## 8) Stream Consumer Internals (`api/streamConsumer.js`)

### Group config

- Stream key: `wa:events:stream`
- Group: `api-consumers`
- Consumer name: `api-<pid>-<timestamp>`

### Behavior

- Ensures consumer group exists (`XGROUP CREATE ... MKSTREAM`).
- Processes pending messages for this consumer (`XREADGROUP ... STREAMS key 0`).
- Long-polls new messages (`BLOCK 1000`, `COUNT 10`, id `>`).
- Parses event from `data` field, calls `broadcast(clientId, event)`.
- ACKs successful messages with `XACK`.
- Handles common errors (`NOGROUP`, timeout, `ECONNREFUSED`) with retry.

### Important note

`api/redisSubscriber.js` (pub/sub path) exists but is not started in `api/index.js` (`require("./redisSubscriber")` is commented). Current event path is stream-based.

---

## 9) Worker Internals (`worker/socketManager.js`)

### Core collections

- `sockets: Map<clientId, sock>`
- `connectedClients: Set<clientId>`
- `senderLoops: Set<clientId>`
- `senderRedisClients: Map<clientId, RedisConnection>`
- `initializingClients: Set<clientId>`
- `reconnectAttempts: Map<clientId, number>`
- `recentNewLoginAt: Map<clientId, timestamp>`

### Redis connections

- `redis`: general commands + queue consumption.
- `redisPub`: dedicated publisher connection for stream writes.
- per-client sender-loop Redis connections for blocking queue reads.
- `ensurePublishConnection()` recreates publisher connection if ping fails.

### Publish strategy

- Events written with `XADD wa:events:stream * data <json>`.
- Publish call wrapped in 10-second timeout race.
- Failures are logged and swallowed (no throw) to avoid worker crash.

### Sender loop behavior

- Single loop per client ID (guarded by `senderLoops` set).
- Infinite BRPOP loop on `wa:pending:<clientId>` with dedicated Redis connection per client loop.
- Requeue behavior if socket missing.
- Random delay between sends to avoid burst sending.

### Baileys handshake/device behavior

- Uses `fetchLatestBaileysVersion()` on each client init and passes `version` to `makeWASocket`.
- Uses configurable browser/device identity:
  - `WA_DEVICE_NAME` (default: `Admissions - CRM`)
  - `WA_DEVICE_PLATFORM` (default: `Linux`)
  - `WA_DEVICE_VERSION` (default: `120.0.0`)

### Media send behavior (`worker/mediaSender.js`)

- Text-only sends `{ text }`.
- Single file:
  - image/video can include caption.
  - audio sends with mimetype.
  - other mimetypes sent as document.
- Multiple files:
  - sends each file individually, then optional trailing text message.

---

## 10) Deployment and Startup

### Docker Compose

`docker-compose.yaml` defines 3 services:

- `redis`
- `worker` (build `./worker`, mounts `./sessions:/sessions`)
- `api` (build `./api`, exposes `3000`)

Worker environment in compose:

- `WA_DEVICE_NAME=Admissions - CRM`
- `WA_DEVICE_PLATFORM=Linux`
- `WA_DEVICE_VERSION=120.0.0`

### Boot sequence

1. Redis starts, healthcheck passes.
2. Worker + API start after Redis health.
3. API starts stream consumer during boot.
4. System ready for `POST /clients/:clientId`.

### Local run (without compose)

Each service expects Redis host `redis` by default; if running outside Compose, host config must be adjusted or `REDIS_HOST` support extended consistently in all modules.

---

## 11) State Machine (Logical)

Typical transitions:

- `CREATED -> CONNECTING -> QR_REQUIRED -> CONNECTED`
- `CONNECTED -> DISCONNECTED -> CONNECTING ...` (transient network issues)
- `CONNECTED -> LOGGED_OUT` (session invalidation / explicit logout)
- `LOGGED_OUT -> CONNECTING` (auto-reinit for fresh QR; reconnect endpoint can also trigger)

The state is stored centrally in Redis hash `wa:clients:state`.

---

## 12) Observability

Current observability is log-heavy and console-based:

- Worker logs connection updates, publish timings, sender loop activity.
- API stream consumer logs message IDs and processing.
- Debug routes expose ws stats, states, QR presence, queue depth.

No metrics backend, tracing, structured centralized logging, or alerting is included.

---

## 13) Technical Gaps / Gotchas To Know Before Extending

1. Mixed legacy vs current event path:
   - Current path: **Redis Streams** (`wa:events:stream`).
   - Legacy path still exists in `old-socketManager.js` and `api/redisSubscriber.js`.

2. `commandListener.js` has `SEND_MESSAGE` handling on `wa:commands`, but current `/messages/send` writes directly to `wa:pending:<clientId>`. That command type is effectively unused from API path.

3. Recipient normalization hardcodes India prefix (`91`) for non-JID phone numbers.

4. No auth on API routes; CORS currently allows any origin (`origin: true`).

5. Redis persistence is disabled in compose config; restart can lose state/queues/events.

6. WebSocket registration still requires at least one client message containing `clientId` after connect.

7. Stream consumer pending recovery uses `XREADGROUP ... 0` for this consumer; cross-consumer stale pending claim/reassignment logic (`XAUTOCLAIM`) is not implemented.

8. Outbound queue currently pops message before send; failed send attempts can lose jobs (no DLQ/retry counter yet).

9. Baileys dependency is pinned to `7.0.0-rc.9`; monitor for protocol drift and upgrade needs.

10. `old-socketManager.js` is legacy and can cause confusion if accidentally referenced.

---

## 14) Suggested Immediate Cleanup Plan (Optional)

1. Standardize fully on Redis Streams:
   - Remove or clearly isolate pub/sub code path.
   - Align debug event injection to stream (`XADD`) instead of pub/sub.

2. Decide one command model:
   - Either keep direct pending queue writes from API or route all outbound actions through `wa:commands`.

3. Add authentication/authorization to API + WS.

4. Externalize config:
   - Redis host/port/timeouts.
   - Country code behavior.
   - queue/stream key names.

5. Add test harness:
   - Route contract tests.
   - Stream consumer unit tests (parse/ack/retry).
   - Socket manager integration test stubs.

---

## 15) Quick Start Interaction Examples

### Create client

```bash
curl -X POST http://localhost:3000/clients/client-1
```

### Check status

```bash
curl http://localhost:3000/clients/client-1/status
```

### Queue text message

```bash
curl -X POST http://localhost:3000/messages/send \
  -H "content-type: application/json" \
  -d '{
    "clientId":"client-1",
    "phoneNumber":"9876543210",
    "text":"Hello from Baileys"
  }'
```

### Queue media message

```bash
curl -X POST http://localhost:3000/messages/send \
  -H "content-type: application/json" \
  -d '{
    "clientId":"client-1",
    "phoneNumber":"9876543210",
    "text":"Please see attached",
    "files":[
      {
        "file_url":"https://example.com/image.jpg",
        "mimeType":"image/jpeg",
        "filename":"image.jpg"
      }
    ]
  }'
```

### Connect WebSocket (example message after connect)

Send after WS connect:

```json
{ "clientId": "client-1" }
```

Optional keepalive:

```json
{ "clientId": "client-1", "type": "ping" }
```

---

## 16) What To Read First For New Work

If continuing development, read in this order:

1. `worker/socketManager.js`
2. `api/streamConsumer.js`
3. `api/routes/ws.js`
4. `api/routes/clients.js`
5. `api/routes/messages.js`
6. `worker/mediaSender.js`

These files define nearly all runtime behavior and integration boundaries.

---

## 17) Current Behavior Snapshot (Feb 2026)

- Event pipeline is Redis Streams based (`wa:events:stream`) end-to-end.
- Worker auto-retries reconnects with backoff and attempt cap.
- `405` disconnects are treated as connection failures with session preservation.
- `515` right after `isNewLogin` is treated as expected restart (no session reset, no forced DISCONNECTED broadcast).
- `LOGGED_OUT`/`401` triggers session clear and automatic QR regeneration flow.
- WebSocket registration includes ping messages (first message with `clientId` registers socket).
- Reconnect API supports both `LOGGED_OUT` and `DISCONNECTED`.
- Device label is configurable and defaults to `Admissions - CRM`.

Recommended frontend WS pattern:

1. On every WS connect, immediately send `{ "clientId": "<id>" }`.
2. Keep sending periodic `{ "clientId": "<id>", "type": "ping" }`.
3. Treat `CONNECTING`, `QR_REQUIRED`, `CONNECTED`, `DISCONNECTED`, `LOGGED_OUT`, `STOPPED` as stream states.

---

## 18) Logging + Per-Client Logs + Restart

### 18.1 Logging levels

The worker and API now respect log levels to reduce terminal noise.

Available levels (least to most noisy):

- `silent` — no logs
- `error` — only failures/crashes
- `warn` — warnings + errors
- `info` — normal operational events
- `debug` — high-volume details

Higher levels include everything below them. Example: `warn` includes `warn` + `error`.

Environment variables:

- `LOG_LEVEL` (default `info`) applies to both services
- `API_LOG_LEVEL` (default `LOG_LEVEL`) controls Fastify + API logs
- `CLIENT_LOG_LEVEL` (default `LOG_LEVEL`) controls per-client log files

In `docker-compose.yaml`, defaults are set to:

- `LOG_LEVEL=warn` (less terminal noise)
- `API_LOG_LEVEL=warn`
- `CLIENT_LOG_LEVEL=info`
- `SCRUB_SIGNAL_LOGS=true` (drops any accidental Signal/ratchet session dumps)

### 18.2 Per-client log files (worker)

Set `LOG_CLIENTS_DIR` to enable per-client logs. In `docker-compose.yaml`:

- `LOG_CLIENTS_DIR=/logs/clients`
- `./logs:/logs` is mounted on the host

Log files:

- `./logs/clients/<clientId>.log`

Restarting/clearing logs:

- Clear one client log:

```bash
: > ./logs/clients/<clientId>.log
```

- Clear all client logs:

```bash
rm -f ./logs/clients/*.log
```

### 18.3 Restart a single client (without restarting the container)

New API endpoint:

`POST /clients/:clientId/restart`

Optional body:

```json
{ "resetSession": true }
```

Behavior:

- Restarts the client socket inside the worker.
- If `resetSession=true`, the session folder is cleared before reconnecting.

Example (restart without session reset):

```bash
curl -X POST http://localhost:3000/clients/<clientId>/restart \
  -H 'content-type: application/json' \
  -d '{"resetSession": false}'
```

Example (restart and clear session):

```bash
curl -X POST http://localhost:3000/clients/<clientId>/restart \
  -H 'content-type: application/json' \
  -d '{"resetSession": true}'
```

### 18.4 Stop a single client (no auto-reconnect)

New API endpoint:

`POST /clients/:clientId/stop`

Optional body:

```json
{ "resetSession": true }
```

Behavior:

- Stops the client socket and prevents auto-reconnect.
- Sets state to `STOPPED`.
- If `resetSession=true`, the session folder is cleared.

Example (stop without session reset):

```bash
curl -X POST http://localhost:3000/clients/<clientId>/stop \
  -H 'content-type: application/json' \
  -d '{"resetSession": false}'
```

Example (stop and clear session):

```bash
curl -X POST http://localhost:3000/clients/<clientId>/stop \
  -H 'content-type: application/json' \
  -d '{"resetSession": true}'
```

### 18.5 Active sockets count

New API endpoint:

`GET /debug/active-clients`

Returns:

- `active`: list of clientIds with initialized sockets in the worker
- `count`: number of active sockets

---

## 19) Dashboard (React + Vite)

A separate dashboard container provides a UI to manage clients, sockets, logs, restarts, and stops.

### 19.1 Run

From `docker-compose.yaml`:

- Service name: `dashboard`
- Port: `8080`
- Basic auth via env:
  - `DASH_USER`
  - `DASH_PASS`

Open:

`http://<host>:8080`

### 19.2 API base

In the UI, set the API base to your Fastify API (default shown):

`http://<host>:3000`

### 19.3 Logs (stdout)

The dashboard reads stdout logs via Docker socket:

- Mount: `/var/run/docker.sock:/var/run/docker.sock`
- Endpoint: `GET /api/logs?service=worker&tail=200`

Services supported: `worker`, `api`, `redis`, `dashboard`.
