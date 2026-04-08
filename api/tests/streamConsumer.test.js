const path = require("path")
const test = require("node:test")
const assert = require("node:assert/strict")

const { loadWithMocks, clearModule } = require("../../test/loadWithMocks")

function buildConsumer() {
  const broadcasts = []
  const ackCalls = []
  const dlqWrites = []

  const redisMock = {
    on() {},
    async xack(...args) {
      ackCalls.push(args)
      return 1
    },
    async xadd(...args) {
      dlqWrites.push(args)
      return "1-0"
    }
  }

  class RedisMock {
    constructor() {
      return redisMock
    }
  }

  const modulePath = path.join(__dirname, "..", "streamConsumer.js")
  const consumer = loadWithMocks(modulePath, {
    ioredis: RedisMock,
    "./wsHub": {
      broadcast(clientId, event) {
        broadcasts.push({ clientId, event })
      }
    },
    "./logger": {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  consumer._test.resetState()

  return { consumer, broadcasts, ackCalls, dlqWrites, modulePath }
}

test("fieldsToObject converts alternating field arrays into an object", (t) => {
  const { consumer, modulePath } = buildConsumer()
  t.after(() => clearModule(modulePath))

  assert.deepEqual(consumer._test.fieldsToObject(["a", "1", "b", "2"]), { a: "1", b: "2" })
})

test("processMessage broadcasts valid events", async (t) => {
  const { consumer, broadcasts, modulePath } = buildConsumer()
  t.after(() => clearModule(modulePath))

  const result = await consumer._test.processMessage("1-0", [
    "data",
    JSON.stringify({ type: "status", clientId: "client-1", state: "CONNECTED" })
  ])

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(broadcasts, [{
    clientId: "client-1",
    event: { type: "status", clientId: "client-1", state: "CONNECTED" }
  }])
})

test("processMessage rejects payloads without a data field", async (t) => {
  const { consumer, modulePath } = buildConsumer()
  t.after(() => clearModule(modulePath))

  const result = await consumer._test.processMessage("1-0", ["foo", "bar"])

  assert.equal(result.ok, false)
  assert.match(result.error, /missing data field/i)
})

test("processMessage rejects invalid event shapes", async (t) => {
  const { consumer, modulePath } = buildConsumer()
  t.after(() => clearModule(modulePath))

  const result = await consumer._test.processMessage("1-0", [
    "data",
    JSON.stringify({ type: "status" })
  ])

  assert.deepEqual(result, { ok: false, error: "Invalid event payload shape" })
})

test("handleProcessResult acknowledges successful messages", async (t) => {
  const { consumer, ackCalls, modulePath } = buildConsumer()
  t.after(() => clearModule(modulePath))

  const handled = await consumer._test.handleProcessResult("1-0", ["data", "{}"], { ok: true }, "new")

  assert.equal(handled, true)
  assert.equal(ackCalls.length, 1)
  assert.deepEqual(ackCalls[0], ["wa:events:stream", "api-consumers", "1-0"])
})

test("handleProcessResult moves poison messages to the DLQ after repeated failures", async (t) => {
  const { consumer, ackCalls, dlqWrites, modulePath } = buildConsumer()
  t.after(() => clearModule(modulePath))

  for (let i = 0; i < 4; i++) {
    const handled = await consumer._test.handleProcessResult("9-0", ["data", "{\"bad\":true}"], { ok: false, error: "bad payload" }, "new")
    assert.equal(handled, false)
  }

  assert.equal(dlqWrites.length, 0)

  const finalHandled = await consumer._test.handleProcessResult("9-0", ["data", "{\"bad\":true}"], { ok: false, error: "bad payload" }, "new")

  assert.equal(finalHandled, false)
  assert.equal(dlqWrites.length, 1)
  assert.equal(ackCalls.length, 1)
  assert.equal(dlqWrites[0][0], "wa:events:dlq")
})
