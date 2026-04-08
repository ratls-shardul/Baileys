const path = require("path")
const test = require("node:test")
const assert = require("node:assert/strict")
const Fastify = require("fastify")

const { loadWithMocks, clearModule } = require("../../test/loadWithMocks")

function createRedisMock() {
  const kv = new Map()
  const hashes = new Map()
  const lists = new Map()

  return {
    async get(key) {
      return kv.has(key) ? kv.get(key) : null
    },
    async set(key, value) {
      kv.set(key, value)
      return "OK"
    },
    async hget(key, field) {
      return hashes.get(key)?.get(field) ?? null
    },
    async hset(key, field, value) {
      if (!hashes.has(key)) hashes.set(key, new Map())
      hashes.get(key).set(field, value)
      return 1
    },
    async hgetall(key) {
      return Object.fromEntries(hashes.get(key)?.entries() ?? [])
    },
    async llen(key) {
      return lists.get(key)?.length ?? 0
    },
    async lrange(key, start, end) {
      const values = lists.get(key) ?? []
      return values.slice(start, end + 1)
    },
    async lpush(key, value) {
      if (!lists.has(key)) lists.set(key, [])
      lists.get(key).unshift(value)
      return lists.get(key).length
    },
    async del(key) {
      kv.delete(key)
      lists.delete(key)
      hashes.delete(key)
      return 1
    },
    seedHash(key, entries) {
      hashes.set(key, new Map(Object.entries(entries)))
    },
    seedList(key, values) {
      lists.set(key, [...values])
    }
  }
}

async function buildApp(redis) {
  const modulePath = path.join(__dirname, "..", "routes", "clients.js")
  const plugin = loadWithMocks(modulePath, {
    "../redis": redis
  })

  const app = Fastify()
  await app.register(plugin)
  return { app, modulePath }
}

test("GET /config/send-delay returns defaults when config is missing", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "GET", url: "/config/send-delay" })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { minMs: 3000, maxMs: 8000, source: "default" })
})

test("GET /config/send-delay falls back to defaults for malformed redis config", async (t) => {
  const redis = createRedisMock()
  await redis.set("wa:config:sendDelay", JSON.stringify({ minMs: 9000, maxMs: 1000 }))
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "GET", url: "/config/send-delay" })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { minMs: 3000, maxMs: 8000, source: "default" })
})

test("POST /config/send-delay normalizes allowed bounds", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "POST",
    url: "/config/send-delay",
    payload: { minMs: 100, maxMs: 150000 }
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, minMs: 500, maxMs: 120000 })
})

test("POST /config/send-delay rejects invalid payloads", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "POST",
    url: "/config/send-delay",
    payload: { minMs: 4000, maxMs: 3000 }
  })

  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /minMs and maxMs are required integers/)
})

test("POST /clients/:clientId creates a client and enqueues ADD_CLIENT", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "POST", url: "/clients/client-1" })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, clientId: "client-1" })
  const clients = await redis.hgetall("wa:clients:state")
  const commands = await redis.lrange("wa:commands", 0, 10)
  assert.equal(clients["client-1"], "CREATED")
  assert.deepEqual(JSON.parse(commands[0]), { type: "ADD_CLIENT", clientId: "client-1" })
})

test("POST /clients/:clientId rejects invalid client ids", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "POST", url: "/clients/bad id" })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, "Invalid clientId format")
})

test("POST /clients/:clientId returns 409 for existing clients", async (t) => {
  const redis = createRedisMock()
  redis.seedHash("wa:clients:state", { "client-1": "CONNECTED" })
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "POST", url: "/clients/client-1" })

  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), {
    error: "Client already exists",
    clientId: "client-1",
    state: "CONNECTED"
  })
})

for (const allowedState of ["LOGGED_OUT", "DISCONNECTED", "STOPPED"]) {
  test(`POST /clients/:clientId/reconnect accepts ${allowedState}`, async (t) => {
    const redis = createRedisMock()
    redis.seedHash("wa:clients:state", { clientA: allowedState })
    const { app, modulePath } = await buildApp(redis)
    t.after(async () => {
      await app.close()
      clearModule(modulePath)
    })

    const res = await app.inject({ method: "POST", url: "/clients/clientA/reconnect" })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ok: true, clientId: "clientA" })
  })
}

test("POST /clients/:clientId/reconnect rejects unsupported states", async (t) => {
  const redis = createRedisMock()
  redis.seedHash("wa:clients:state", { clientA: "CONNECTED" })
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "POST", url: "/clients/clientA/reconnect" })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, "Client must be LOGGED_OUT, DISCONNECTED, or STOPPED")
})

test("GET /clients/:clientId/queue returns parsed and raw rows with bounded limit", async (t) => {
  const redis = createRedisMock()
  redis.seedList("wa:pending:client-1", [
    JSON.stringify({ text: "hello" }),
    "{bad-json}"
  ])
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "GET", url: "/clients/client-1/queue?limit=999" })

  assert.equal(res.statusCode, 200)
  assert.equal(res.json().clientId, "client-1")
  assert.equal(res.json().total, 2)
  assert.equal(res.json().limit, 200)
  assert.deepEqual(res.json().messages[0], {
    index: 0,
    raw: JSON.stringify({ text: "hello" }),
    parsed: { text: "hello" }
  })
  assert.equal(res.json().messages[1].parsed, null)
})

test("DELETE /clients/:clientId/queue clears queued messages", async (t) => {
  const redis = createRedisMock()
  redis.seedList("wa:pending:client-2", ["a", "b", "c"])
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "DELETE", url: "/clients/client-2/queue" })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, clientId: "client-2", cleared: 3 })
  assert.equal(await redis.llen("wa:pending:client-2"), 0)
})

test("GET /clients/:clientId/status returns NON_EXISTENT for unknown clients", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({ method: "GET", url: "/clients/missing/status" })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { clientId: "missing", state: "NON_EXISTENT" })
})
