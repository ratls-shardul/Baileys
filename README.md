# Baileys WhatsApp Worker + API (Redis-Orchestrated)

Containerized WhatsApp backend with four services:

- `proxy`: Nginx TLS terminator for HTTPS/WSS origin traffic
- `worker`: runs Baileys sockets (one per `clientId`) and sends queued messages.
- `api`: Fastify REST + WebSocket endpoints, and Redis stream consumer.
- `redis`: shared state, command, queue, and event bus.
- `dashboard`: React + Vite UI for operations and logs.

## 1) Architecture

```text
Client / Frontend
   │
   ├── REST/HTTPS ───────────────► Proxy (Nginx)
   │                               └── forwards to API (Fastify)
   │
   ├── REST ─────────────────────► API (Fastify)
   │                               ├── writes to Redis (commands / queues)
   │                               ├── reads state/QR from Redis
   │                               └── exposes /ws for realtime state/QR
   │
   └── WebSocket (/ws, WSS) ◄──── wsHub broadcasts
                                   ▲
                                   │
Redis Stream wa:events:stream ◄── Worker publishes QR/status
                                   │
Redis Lists/Hash/Keys ◄────────── API + Worker share commands/state/queues
                                   │
                                   ▼
                              Worker (Baileys socket manager)
```

## 2) Current Repository Structure

```text
.
├── AGENTS.md
├── README.md
├── docker-compose.yaml
├── nginx
│   ├── certs
│   │   └── .gitkeep
│   └── conf.d
│       └── default.conf
├── api
│   ├── index.js
│   ├── logger.js
│   ├── redis.js
│   ├── redisSubscriber.js       # legacy (not used)
│   ├── streamConsumer.js
│   ├── wsHub.js
│   └── routes
│       ├── clients.js
│       ├── debug-routes.js
│       ├── messages.js
│       └── ws.js
├── worker
│   ├── index.js
│   ├── commandListener.js
│   ├── clientState.js
│   ├── logger.js
│   ├── mediaSender.js
│   ├── old-socketManager.js     # legacy
│   ├── sessionUtils.js
│   └── socketManager.js
└── dashboard
    ├── server/index.js
    └── src
        ├── App.jsx
        └── styles.css
```

## 3) Redis Keys and Contracts

- `wa:clients:state` (Hash): `clientId -> state`
  - states: `CREATED | CONNECTING | QR_REQUIRED | CONNECTED | DISCONNECTED | LOGGED_OUT | STOPPED`
- `wa:commands` (List): worker control commands (`ADD_CLIENT`, `RESTART_CLIENT`, `STOP_CLIENT`, `DELETE_CLIENT`)
- `wa:pending:<clientId>` (List): outbound message queue per client
- `wa:qr:<clientId>` (String, TTL 120s): latest QR payload
- `wa:clients:active` (Set): active sockets known by worker
- `wa:events:stream` (Stream): worker -> API events (`data` JSON)
- `wa:events:dlq` (Stream): poison events moved by API stream consumer

## 4) Runtime Behavior

### 4.1 Client lifecycle

1. `POST /clients/:clientId` creates logical client (`CREATED`) and enqueues `ADD_CLIENT`.
2. Worker initializes client (`CONNECTING`) and starts Baileys socket.
3. On QR: state `QR_REQUIRED`, QR stored in `wa:qr:<clientId>`, QR event published to stream.
4. On open: state `CONNECTED`, QR key deleted, status event published.
5. On `401` / logged out: state `LOGGED_OUT`, session cleared, auto reinit for fresh QR.
6. On `515` after new login: treated as expected restart (state `CONNECTING`, no session reset).
7. On other disconnects: state `DISCONNECTED`, retry with capped backoff.
   - transport/time-out disconnects such as `405`, `408`, and `428` preserve the existing session during retries to avoid unnecessary QR churn.
   - if retry cap is exceeded, worker forces a fresh session reset and reinitializes to regenerate QR.
8. Manual `stop` moves client to `STOPPED` and prevents auto-reconnect.

### 4.2 Outbound queue guarantees (current)

- API always enqueues outbound payloads into `wa:pending:<clientId>`.
- Worker sender loop **does not dequeue** while socket is missing or client is not connected.
- Queue items remain in Redis until client becomes `CONNECTED`.
- Sending is one-by-one with random delay (`2-5s`) between successful sends.
- If send fails after dequeue, worker re-queues message and retries later.

This supports the edge case where messages are pushed before client is initialized.

### 4.3 Media behavior

- Image/video can use caption.
- PDF/documents are sent as document + separate text message.
- Invalid media payloads fail safely (validation + guarded builder).

## 5) API Endpoints

### 5.1 Health

- `GET /health` -> `{ status: "ok" }`

### 5.2 Client management

- `GET /clients`
- `POST /clients/:clientId`
  - validates `clientId` format
  - returns `409` if already exists (no state reset)
- `POST /clients/:clientId/reconnect`
  - allowed states: `LOGGED_OUT | DISCONNECTED | STOPPED`
- `POST /clients/:clientId/restart` body `{ resetSession?: boolean }`
- `POST /clients/:clientId/stop` body `{ resetSession?: boolean }`
- `DELETE /clients/:clientId`
- `GET /clients/:clientId/status`

### 5.3 Queue operations

- `POST /messages/send`
  - required: `clientId`, `phoneNumber`
  - requires non-empty text and/or valid `files[]`
  - file validation: each file needs `file_url` + `mimeType`
- `GET /clients/:clientId/queue?limit=<1..200>`
  - returns total + parsed/raw queued entries
- `DELETE /clients/:clientId/queue`
  - clears pending queue for that client

### 5.4 WebSocket

- `GET /ws` (upgrade)
- first inbound message must include `clientId` (ping message also works)
- ping format: `{ "clientId": "...", "type": "ping" }`
- replies with pong: `{ "type": "pong", "timestamp": <ms> }`
- sends current status immediately after registration
- sends QR payload if available in Redis

### 5.5 Debug

- `GET /debug/ws-stats`
- `GET /debug/client-states`
- `GET /debug/active-clients`
- `POST /debug/test-broadcast/:clientId` (writes test event to stream)
- `GET /debug/qr/:clientId`
- `GET /debug/pending/:clientId`

## 6) Stream Consumer Reliability (`api/streamConsumer.js`)

- Uses Redis consumer group `api-consumers` on `wa:events:stream`.
- Validates stream event shape (`clientId`, `type`).
- Ack on successful processing.
- Tracks per-message failures in-memory.
- Moves poison messages to DLQ stream after threshold.
- Uses `XAUTOCLAIM` to recover stale pending entries from dead consumers.

Environment knobs:

- `WA_EVENTS_DLQ_STREAM` (default `wa:events:dlq`)
- `WA_EVENTS_POISON_THRESHOLD` (default `5`)
- `WA_EVENTS_AUTOCLAIM_MIN_IDLE_MS` (default `60000`)
- `WA_EVENTS_AUTOCLAIM_BATCH_SIZE` (default `50`)

## 7) Dashboard (Operations UI)

Dashboard runs on `:8080` with basic auth (`DASH_USER`, `DASH_PASS`).

Capabilities:

- create/reconnect/restart/stop/delete clients
- monitor states, active sockets, websocket fanout counts
- view container stdout logs (`worker`, `api`, `redis`, `dashboard`)
- queue tools:
  - per-client `View Queue` and `Clear Queue`
  - manual queue lookup/clear for any `clientId` (including non-initialized clients)

## 8) Docker Compose Notes

`docker-compose.yaml` includes `redis`, `worker`, `api`, `proxy`, and `dashboard`.

Important current defaults:

- `proxy` terminates TLS on host port `443` using `nginx/certs/origin.crt` and `nginx/certs/origin.key`.
- `api` remains internal on Docker port `3000`; HTTPS and WSS traffic should enter through `proxy`.
- Redis persistence disabled (`--save ""`, `--appendonly no`) -> data is ephemeral on restart
- Worker logs configured via:
  - `LOG_LEVEL`
  - `CLIENT_LOG_LEVEL`
  - `LOG_CLIENTS_DIR=/logs/clients`
  - `SCRUB_SIGNAL_LOGS=true`

Certificate setup:

1. Put your Cloudflare Origin CA certificate at `nginx/certs/origin.crt`
2. Put the private key at `nginx/certs/origin.key`
3. Recreate the proxy service:

```bash
docker compose up -d --force-recreate proxy api
```

4. Keep Cloudflare SSL/TLS mode on `Full` or `Full (strict)`

Create the files directly on the EC2 instance:

```bash
mkdir -p nginx/certs
nano nginx/certs/origin.crt
```

Paste the full Cloudflare Origin Certificate content, save, then create the key:

```bash
nano nginx/certs/origin.key
```

Paste the full private key content and save.

If you prefer shell redirection instead of an editor:

```bash
cat > nginx/certs/origin.crt <<'EOF'
-----BEGIN CERTIFICATE-----
PASTE_YOUR_CLOUDFLARE_ORIGIN_CERTIFICATE_HERE
-----END CERTIFICATE-----
EOF
```

```bash
cat > nginx/certs/origin.key <<'EOF'
-----BEGIN PRIVATE KEY-----
PASTE_YOUR_PRIVATE_KEY_HERE
-----END PRIVATE KEY-----
EOF
```

Recommended permissions:

```bash
chmod 600 nginx/certs/origin.key
chmod 644 nginx/certs/origin.crt
```

Verify the files exist before restarting:

```bash
ls -l nginx/certs
```

## 9) Known Gaps

- API and WS endpoints are unauthenticated; CORS is permissive.
- Redis host is still hardcoded to `redis` in multiple worker/api modules.
- Outbound queue has requeue-on-failure but no explicit retry counter / outbound DLQ.
- `old-socketManager.js` and `api/redisSubscriber.js` are legacy and not active path.

## 10) Quick Commands

Create client:

```bash
curl -k -X POST https://localhost/clients/client-1
```

Queue text:

```bash
curl -k -X POST https://localhost/messages/send \
  -H "content-type: application/json" \
  -d '{"clientId":"client-1","phoneNumber":"9876543210","text":"hello"}'
```

View queue:

```bash
curl -k "https://localhost/clients/client-1/queue?limit=20"
```

Clear queue:

```bash
curl -k -X DELETE "https://localhost/clients/client-1/queue"
```

Check status:

```bash
curl -k https://localhost/clients/client-1/status
```
