const path = require("path")
const test = require("node:test")
const assert = require("node:assert/strict")
const Fastify = require("fastify")

const { loadWithMocks, clearModule } = require("../../test/loadWithMocks")

function createRedisMock() {
  const kv = new Map()
  const hashes = new Map()
  const lists = new Map()
  // Sorted sets stored as arrays of {score, member} sorted ascending by score
  const zsets = new Map()

  function getZSet(key) {
    if (!zsets.has(key)) zsets.set(key, [])
    return zsets.get(key)
  }

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
      zsets.delete(key)
      return 1
    },
    async zadd(key, score, member) {
      const set = getZSet(key)
      set.push({ score: Number(score), member })
      set.sort((a, b) => a.score - b.score)
      return 1
    },
    async zremrangebyscore(key, min, max) {
      const set = getZSet(key)
      const lo = min === "-inf" ? -Infinity : Number(min)
      const hi = max === "+inf" ? Infinity : Number(max)
      const before = set.length
      const remaining = set.filter(e => e.score < lo || e.score > hi)
      zsets.set(key, remaining)
      return before - remaining.length
    },
    async zrevrangebyscore(key, max, min, ...args) {
      const set = getZSet(key)
      const lo = min === "-inf" ? -Infinity : Number(min)
      const hi = max === "+inf" ? Infinity : Number(max)
      let filtered = set.filter(e => e.score >= lo && e.score <= hi)
      filtered = [...filtered].sort((a, b) => b.score - a.score)

      // Handle 'LIMIT', offset, count
      if (args[0] === "LIMIT") {
        const offset = Number(args[1])
        const count = Number(args[2])
        filtered = filtered.slice(offset, offset + count)
      }

      return filtered.map(e => e.member)
    },
    async zcard(key) {
      return zsets.get(key)?.length ?? 0
    },
    seedHash(key, entries) {
      hashes.set(key, new Map(Object.entries(entries)))
    },
    seedList(key, values) {
      lists.set(key, [...values])
    },
    seedZSet(key, entries) {
      // entries: [{score, member}]
      zsets.set(key, [...entries].sort((a, b) => a.score - b.score))
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

// ─── helpers ────────────────────────────────────────────────────────────────

function makeEntry(phoneNumber, sentAt, status, overrides = {}) {
  return {
    phoneNumber,
    sentAt,
    status,
    text: "hello",
    fileCount: 0,
    ...overrides
  }
}

// ─── tests ──────────────────────────────────────────────────────────────────

test("GET /clients/:clientId/messages/log returns empty result for unknown client", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => { await app.close(); clearModule(modulePath) })

  const res = await app.inject({ method: "GET", url: "/clients/client-1/messages/log" })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    clientId: "client-1",
    total: 0,
    returned: 0,
    limit: 50,
    messages: []
  })
})

test("GET /clients/:clientId/messages/log returns entries newest-first", async (t) => {
  const redis = createRedisMock()
  const entry1 = makeEntry("111", 1000, "sent")
  const entry2 = makeEntry("222", 2000, "sent")
  const entry3 = makeEntry("333", 3000, "failed", { failReason: "timeout" })
  redis.seedZSet("wa:msglog:client-1", [
    { score: 1000, member: JSON.stringify(entry1) },
    { score: 2000, member: JSON.stringify(entry2) },
    { score: 3000, member: JSON.stringify(entry3) }
  ])

  const { app, modulePath } = await buildApp(redis)
  t.after(async () => { await app.close(); clearModule(modulePath) })

  const res = await app.inject({ method: "GET", url: "/clients/client-1/messages/log" })

  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.returned, 3)
  assert.equal(body.total, 3)
  assert.equal(body.messages[0].phoneNumber, "333")
  assert.equal(body.messages[1].phoneNumber, "222")
  assert.equal(body.messages[2].phoneNumber, "111")
})

test("GET /clients/:clientId/messages/log default limit is 50", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => { await app.close(); clearModule(modulePath) })

  const res = await app.inject({ method: "GET", url: "/clients/client-1/messages/log" })

  assert.equal(res.statusCode, 200)
  assert.equal(res.json().limit, 50)
})

test("GET /clients/:clientId/messages/log limit is capped at 200", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => { await app.close(); clearModule(modulePath) })

  const res = await app.inject({ method: "GET", url: "/clients/client-1/messages/log?limit=999" })

  assert.equal(res.statusCode, 200)
  assert.equal(res.json().limit, 200)
})

test("GET /clients/:clientId/messages/log limit is floored at 1", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => { await app.close(); clearModule(modulePath) })

  const res = await app.inject({ method: "GET", url: "/clients/client-1/messages/log?limit=0" })

  assert.equal(res.statusCode, 200)
  assert.equal(res.json().limit, 1)
})

test("GET /clients/:clientId/messages/log total reflects full set size not just returned", async (t) => {
  const redis = createRedisMock()
  // Seed 5 entries but only ask for 2
  for (let i = 1; i <= 5; i++) {
    await redis.zadd("wa:msglog:client-1", i * 1000, JSON.stringify(makeEntry("111", i * 1000, "sent")))
  }

  const { app, modulePath } = await buildApp(redis)
  t.after(async () => { await app.close(); clearModule(modulePath) })

  const res = await app.inject({ method: "GET", url: "/clients/client-1/messages/log?limit=2" })

  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.total, 5)
  assert.equal(body.returned, 2)
  assert.equal(body.limit, 2)
})

test("GET /clients/:clientId/messages/log before parameter filters to older entries", async (t) => {
  const redis = createRedisMock()
  redis.seedZSet("wa:msglog:client-1", [
    { score: 1000, member: JSON.stringify(makeEntry("old", 1000, "sent")) },
    { score: 2000, member: JSON.stringify(makeEntry("mid", 2000, "sent")) },
    { score: 3000, member: JSON.stringify(makeEntry("new", 3000, "sent")) }
  ])

  const { app, modulePath } = await buildApp(redis)
  t.after(async () => { await app.close(); clearModule(modulePath) })

  // Ask for entries at or before score=2000 (mid and old, newest-first)
  const res = await app.inject({
    method: "GET",
    url: "/clients/client-1/messages/log?before=2000"
  })

  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.returned, 2)
  assert.equal(body.messages[0].phoneNumber, "mid")
  assert.equal(body.messages[1].phoneNumber, "old")
})

test("GET /clients/:clientId/messages/log failed entries include failReason", async (t) => {
  const redis = createRedisMock()
  const failEntry = makeEntry("9999", 5000, "failed", { failReason: "socket closed" })
  redis.seedZSet("wa:msglog:client-1", [
    { score: 5000, member: JSON.stringify(failEntry) }
  ])

  const { app, modulePath } = await buildApp(redis)
  t.after(async () => { await app.close(); clearModule(modulePath) })

  const res = await app.inject({ method: "GET", url: "/clients/client-1/messages/log" })

  assert.equal(res.statusCode, 200)
  const msg = res.json().messages[0]
  assert.equal(msg.status, "failed")
  assert.equal(msg.failReason, "socket closed")
})

test("GET /clients/:clientId/messages/log returns sent entries without failReason", async (t) => {
  const redis = createRedisMock()
  const sentEntry = makeEntry("8888", 6000, "sent")
  redis.seedZSet("wa:msglog:client-1", [
    { score: 6000, member: JSON.stringify(sentEntry) }
  ])

  const { app, modulePath } = await buildApp(redis)
  t.after(async () => { await app.close(); clearModule(modulePath) })

  const res = await app.inject({ method: "GET", url: "/clients/client-1/messages/log" })

  assert.equal(res.statusCode, 200)
  const msg = res.json().messages[0]
  assert.equal(msg.status, "sent")
  assert.equal(msg.failReason, undefined)
})

test("GET /clients/:clientId/messages/log handles malformed stored entries gracefully", async (t) => {
  const redis = createRedisMock()
  redis.seedZSet("wa:msglog:client-1", [
    { score: 1000, member: "{not-valid-json" }
  ])

  const { app, modulePath } = await buildApp(redis)
  t.after(async () => { await app.close(); clearModule(modulePath) })

  const res = await app.inject({ method: "GET", url: "/clients/client-1/messages/log" })

  assert.equal(res.statusCode, 200)
  const msg = res.json().messages[0]
  assert.equal(msg.parseError, true)
  assert.equal(msg.raw, "{not-valid-json")
})

test("GET /clients/:clientId/messages/log entries contain all expected fields for sent status", async (t) => {
  const redis = createRedisMock()
  const entry = {
    phoneNumber: "9876543210",
    sentAt: 7000,
    status: "sent",
    text: "test message",
    fileCount: 2
  }
  redis.seedZSet("wa:msglog:client-1", [
    { score: 7000, member: JSON.stringify(entry) }
  ])

  const { app, modulePath } = await buildApp(redis)
  t.after(async () => { await app.close(); clearModule(modulePath) })

  const res = await app.inject({ method: "GET", url: "/clients/client-1/messages/log" })

  assert.equal(res.statusCode, 200)
  const msg = res.json().messages[0]
  assert.equal(msg.phoneNumber, "9876543210")
  assert.equal(msg.sentAt, 7000)
  assert.equal(msg.status, "sent")
  assert.equal(msg.text, "test message")
  assert.equal(msg.fileCount, 2)
})
