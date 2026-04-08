const path = require("path")
const test = require("node:test")
const assert = require("node:assert/strict")
const Fastify = require("fastify")

const { loadWithMocks, clearModule } = require("../../test/loadWithMocks")

function createRedisMock() {
  const lists = new Map()
  return {
    async lpush(key, value) {
      if (!lists.has(key)) lists.set(key, [])
      lists.get(key).unshift(value)
      return lists.get(key).length
    },
    async lrange(key, start, end) {
      return (lists.get(key) ?? []).slice(start, end + 1)
    }
  }
}

async function buildApp(redis) {
  const modulePath = path.join(__dirname, "..", "routes", "messages.js")
  const plugin = loadWithMocks(modulePath, {
    "../redis": redis
  })
  const app = Fastify()
  await app.register(plugin)
  return { app, modulePath }
}

test("POST /messages/send queues trimmed text messages", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "POST",
    url: "/messages/send",
    payload: {
      clientId: "client-1",
      phoneNumber: "9999999999",
      text: "  hello  "
    }
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, queued: true })
  const rows = await redis.lrange("wa:pending:client-1", 0, 10)
  assert.deepEqual(JSON.parse(rows[0]), {
    type: "SEND_MESSAGE",
    clientId: "client-1",
    phoneNumber: "9999999999",
    text: "hello",
    files: []
  })
})

test("POST /messages/send queues file-only messages", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "POST",
    url: "/messages/send",
    payload: {
      clientId: "client-2",
      phoneNumber: "9999999999",
      files: [{ file_url: "https://example.com/a.pdf", mimeType: "application/pdf" }]
    }
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, queued: true })
})

test("POST /messages/send rejects missing required fields", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "POST",
    url: "/messages/send",
    payload: { text: "hello" }
  })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, "Missing fields")
})

test("POST /messages/send rejects non-array files", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "POST",
    url: "/messages/send",
    payload: {
      clientId: "client-1",
      phoneNumber: "9999999999",
      files: {}
    }
  })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, "files must be an array")
})

test("POST /messages/send rejects invalid file entries", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "POST",
    url: "/messages/send",
    payload: {
      clientId: "client-1",
      phoneNumber: "9999999999",
      files: [{ file_url: "", mimeType: "image/png" }]
    }
  })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, "Each file requires non-empty file_url and mimeType")
})

test("POST /messages/send rejects empty text when no files are present", async (t) => {
  const redis = createRedisMock()
  const { app, modulePath } = await buildApp(redis)
  t.after(async () => {
    await app.close()
    clearModule(modulePath)
  })

  const res = await app.inject({
    method: "POST",
    url: "/messages/send",
    payload: {
      clientId: "client-1",
      phoneNumber: "9999999999",
      text: "   "
    }
  })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, "Nothing to send")
})
