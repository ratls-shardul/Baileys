const path = require("path")
const test = require("node:test")
const assert = require("node:assert/strict")

const { loadWithMocks, clearModule } = require("../../test/loadWithMocks")

function buildHarness({ states = {}, sessionEntries = [], initFailures = new Set() } = {}) {
  const initCalls = []
  const loggerCalls = {
    info: [],
    warn: [],
    error: []
  }

  class RedisMock {
    async hgetall() {
      return states
    }
  }

  const modulePath = path.join(__dirname, "..", "startupRehydrate.js")
  const startupRehydrate = loadWithMocks(modulePath, {
    fs: {
      readdirSync() {
        return sessionEntries.map((name) => ({
          name,
          isDirectory() {
            return true
          }
        }))
      }
    },
    ioredis: RedisMock,
    "./socketManager": {
      async initClient(clientId) {
        initCalls.push(clientId)
        if (initFailures.has(clientId)) {
          throw new Error(`init failed for ${clientId}`)
        }
      }
    },
    "./logger": {
      info(message) {
        loggerCalls.info.push(message)
      },
      warn(message) {
        loggerCalls.warn.push(message)
      },
      error(message, meta) {
        loggerCalls.error.push({ message, meta })
      }
    }
  })

  return {
    startupRehydrate,
    initCalls,
    loggerCalls,
    modulePath
  }
}

test("collectClientsToRehydrate merges redis states with session directories and skips stopped/logged-out clients", async (t) => {
  const harness = buildHarness({
    states: {
      activeFromRedis: "CONNECTED",
      stoppedClient: "STOPPED",
      loggedOutClient: "LOGGED_OUT",
      needsQr: "CREATED"
    },
    sessionEntries: ["activeFromRedis", "sessionOnly", "stoppedClient"]
  })
  t.after(() => clearModule(harness.modulePath))

  const clientIds = await harness.startupRehydrate._test.collectClientsToRehydrate()

  assert.deepEqual(clientIds, ["activeFromRedis", "needsQr", "sessionOnly"])
})

test("rehydrateClients initializes all eligible clients in sorted order", async (t) => {
  const harness = buildHarness({
    states: {
      clientB: "DISCONNECTED",
      clientA: "CONNECTED"
    },
    sessionEntries: ["clientC"]
  })
  t.after(() => clearModule(harness.modulePath))

  const clientIds = await harness.startupRehydrate.rehydrateClients()

  assert.deepEqual(clientIds, ["clientA", "clientB", "clientC"])
  assert.deepEqual(harness.initCalls, ["clientA", "clientB", "clientC"])
})

test("rehydrateClients continues when one client fails to initialize", async (t) => {
  const harness = buildHarness({
    sessionEntries: ["clientA", "clientB"],
    initFailures: new Set(["clientA"])
  })
  t.after(() => clearModule(harness.modulePath))

  const clientIds = await harness.startupRehydrate.rehydrateClients()

  assert.deepEqual(clientIds, ["clientA", "clientB"])
  assert.deepEqual(harness.initCalls, ["clientA", "clientB"])
  assert.equal(harness.loggerCalls.error.length, 1)
  assert.match(harness.loggerCalls.error[0].message, /Failed to rehydrate client 'clientA'/)
})
