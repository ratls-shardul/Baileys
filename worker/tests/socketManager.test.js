const path = require("path")
const test = require("node:test")
const assert = require("node:assert/strict")

const { loadWithMocks, clearModule } = require("../../test/loadWithMocks")

function createSocketManagerHarness({ sendShouldFail = true } = {}) {
  const stateTransitions = []
  const clearedSessions = []
  const redisInstances = []
  const fakeSockets = []
  const timeoutCalls = []
  const sentMessages = []
  let queueBrpopCalls = 0
  let requeued = []
  let stopLoopAfterSend = null
  let stopLoopAfterRequeue = null

  class FakeRedis {
    constructor() {
      this.events = {}
      this.xaddCalls = []
      this.zaddCalls = []
      this.zremrangebyscoreCalls = []
      this.deletedKeys = []
      redisInstances.push(this)
    }

    on(event, handler) {
      this.events[event] = handler
    }

    async ping() {
      return "PONG"
    }

    async xadd(...args) {
      this.xaddCalls.push(args)
      return "1-0"
    }

    async zadd(key, score, member) {
      this.zaddCalls.push({ key, score, member })
      return 1
    }

    async zremrangebyscore(key, min, max) {
      this.zremrangebyscoreCalls.push({ key, min, max })
      return 0
    }

    async sadd() {
      return 1
    }

    async srem() {
      return 1
    }

    async set() {
      return "OK"
    }

    async del(key) {
      this.deletedKeys.push(key)
      return 1
    }

    async get() {
      return null
    }

    async brpop() {
      queueBrpopCalls += 1
      return [
        "wa:pending:client-1",
        JSON.stringify({
          type: "SEND_MESSAGE",
          clientId: "client-1",
          phoneNumber: "9999999999",
          text: "hello",
          files: []
        })
      ]
    }

    async rpush(key, value) {
      requeued.push({ key, value })
      if (stopLoopAfterRequeue) {
        stopLoopAfterRequeue()
      }
      return 1
    }

    disconnect() {}
  }

  function makeFakeSocket() {
    const handlers = {}
    const socket = {
      handlers,
      ev: {
        on(event, handler) {
          handlers[event] = handler
        },
        removeAllListeners() {}
      },
      end() {}
    }
    fakeSockets.push(socket)
    return socket
  }

  const modulePath = path.join(__dirname, "..", "socketManager.js")
  const originalSetTimeout = global.setTimeout
  global.setTimeout = (fn, delay) => {
    timeoutCalls.push({ fn, delay })
    return 0
  }

  const socketManager = loadWithMocks(modulePath, {
    "@whiskeysockets/baileys": {
      makeWASocket: makeFakeSocket,
      useMultiFileAuthState: async () => ({ state: {}, saveCreds() {} }),
      DisconnectReason: { loggedOut: 401 },
      fetchLatestBaileysVersion: async () => ({ version: [1, 2, 3], isLatest: true })
    },
    pino: () => ({ child() { return {} } }),
    "./sessionUtils": {
      clearSession(clientId) {
        clearedSessions.push(clientId)
      }
    },
    "./clientState": {
      STATES: {
        CONNECTING: "CONNECTING",
        CONNECTED: "CONNECTED",
        DISCONNECTED: "DISCONNECTED",
        LOGGED_OUT: "LOGGED_OUT",
        STOPPED: "STOPPED",
        QR_REQUIRED: "QR_REQUIRED"
      },
      async setClientState(clientId, state) {
        stateTransitions.push({ clientId, state })
      },
      async removeClientState() {}
    },
    ioredis: FakeRedis,
    "./mediaSender": {
      async sendMessageWithMedia(sock, jid, payload) {
        sentMessages.push({ sock, jid, payload })
        if (sendShouldFail) {
          throw new Error("send failed")
        }
        if (stopLoopAfterSend) {
          stopLoopAfterSend()
        }
      }
    },
    "./logger": {
      info() {},
      warn() {},
      error() {},
      clientLog() {}
    }
  })

  function restore() {
    global.setTimeout = originalSetTimeout
    clearModule(modulePath)
  }

  stopLoopAfterRequeue = () => {
    socketManager._test.stopSenderLoop("client-1")
  }

  stopLoopAfterSend = () => {
    socketManager._test.stopSenderLoop("client-1")
  }

  return {
    socketManager,
    stateTransitions,
    clearedSessions,
    redisInstances,
    fakeSockets,
    timeoutCalls,
    sentMessages,
    getQueueBrpopCalls: () => queueBrpopCalls,
    getRequeued: () => requeued,
    getZaddCalls: () => redisInstances.flatMap(r => r.zaddCalls),
    getZremCalls: () => redisInstances.flatMap(r => r.zremrangebyscoreCalls),
    getDeletedKeys: () => redisInstances.flatMap(r => r.deletedKeys),
    restore
  }
}

async function initAndGetConnectionHandler(harness, clientId = "client-1") {
  await harness.socketManager.initClient(clientId)
  const socket = harness.fakeSockets[0]
  return socket.handlers["connection.update"]
}

function latestReconnectDelay(harness) {
  return harness.timeoutCalls.filter(({ delay }) => delay !== 10000).slice(-1)[0]?.delay
}

for (const statusCode of [405, 408, 428]) {
  test(`recoverable disconnect ${statusCode} preserves the session and schedules a slower reconnect`, async (t) => {
    const harness = createSocketManagerHarness()
    t.after(() => harness.restore())
    const onUpdate = await initAndGetConnectionHandler(harness)

    await onUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode } } }
    })

    assert.deepEqual(harness.clearedSessions, [])
    assert.deepEqual(harness.stateTransitions.slice(-1)[0], {
      clientId: "client-1",
      state: "DISCONNECTED"
    })
    assert.equal(latestReconnectDelay(harness), 15000)
  })
}

test("non-recoverable disconnect preserves the session and uses the short retry delay", async (t) => {
  const harness = createSocketManagerHarness()
  t.after(() => harness.restore())
  const onUpdate = await initAndGetConnectionHandler(harness)

  await onUpdate({
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 500 } } }
  })

  assert.deepEqual(harness.clearedSessions, [])
  assert.deepEqual(harness.stateTransitions.slice(-1)[0], {
    clientId: "client-1",
    state: "DISCONNECTED"
  })
  assert.equal(latestReconnectDelay(harness), 3000)
})

test("logged-out disconnect clears the session and reinitializes for a new QR", async (t) => {
  const harness = createSocketManagerHarness()
  t.after(() => harness.restore())
  const onUpdate = await initAndGetConnectionHandler(harness)

  await onUpdate({
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 401 } } }
  })

  assert.deepEqual(harness.clearedSessions, ["client-1"])
  assert.deepEqual(harness.stateTransitions.slice(-1)[0], {
    clientId: "client-1",
    state: "LOGGED_OUT"
  })
  assert.equal(latestReconnectDelay(harness), 1500)
})

test("disconnects beyond the retry cap keep retrying with the existing session", async (t) => {
  const harness = createSocketManagerHarness()
  t.after(() => harness.restore())
  const onUpdate = await initAndGetConnectionHandler(harness)

  for (let i = 0; i < 9; i++) {
    await onUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 408 } } }
    })
  }

  assert.equal(harness.clearedSessions.length, 0)
  assert.deepEqual(harness.stateTransitions.slice(-1)[0], {
    clientId: "client-1",
    state: "DISCONNECTED"
  })
  assert.equal(latestReconnectDelay(harness), 120000)
})

test("duplicate initClient returns the existing socket without resetting state", async (t) => {
  const harness = createSocketManagerHarness()
  t.after(() => harness.restore())

  const firstSocket = await harness.socketManager.initClient("client-1")
  const stateCountAfterFirstInit = harness.stateTransitions.length

  const secondSocket = await harness.socketManager.initClient("client-1")

  assert.equal(secondSocket, firstSocket)
  assert.equal(harness.stateTransitions.length, stateCountAfterFirstInit)
})

test("failed send is logged with status failed and failReason before re-queueing", async (t) => {
  const harness = createSocketManagerHarness({ sendShouldFail: true })
  t.after(() => harness.restore())

  harness.socketManager._test.resetState()

  const originalSetTimeout = global.setTimeout
  global.setTimeout = (fn) => { fn(); return 0 }
  t.after(() => { global.setTimeout = originalSetTimeout })

  harness.socketManager._test.setConnectedSocket("client-1", { id: "sock-1" })
  await harness.socketManager.startSenderLoop("client-1")

  const zaddCalls = harness.getZaddCalls().filter(c => c.key === "wa:msglog:client-1")
  assert.equal(zaddCalls.length, 1)

  const entry = JSON.parse(zaddCalls[0].member)
  assert.equal(entry.status, "failed")
  assert.equal(entry.phoneNumber, "9999999999")
  assert.equal(entry.text, "hello")
  assert.equal(entry.fileCount, 0)
  assert.equal(typeof entry.failReason, "string")
  assert.ok(entry.failReason.length > 0)
  assert.ok(typeof entry.sentAt === "number")
})

test("failed send triggers TTL trim on the message log key", async (t) => {
  const harness = createSocketManagerHarness({ sendShouldFail: true })
  t.after(() => harness.restore())

  harness.socketManager._test.resetState()

  const originalSetTimeout = global.setTimeout
  global.setTimeout = (fn) => { fn(); return 0 }
  t.after(() => { global.setTimeout = originalSetTimeout })

  harness.socketManager._test.setConnectedSocket("client-1", { id: "sock-1" })
  await harness.socketManager.startSenderLoop("client-1")

  const zremCalls = harness.getZremCalls().filter(c => c.key === "wa:msglog:client-1")
  assert.equal(zremCalls.length, 1)
  assert.equal(zremCalls[0].min, "-inf")
  assert.ok(typeof zremCalls[0].max === "number")
})

test("successful send is logged with status sent", async (t) => {
  const harness = createSocketManagerHarness({ sendShouldFail: false })
  t.after(() => harness.restore())

  harness.socketManager._test.resetState()

  const originalSetTimeout = global.setTimeout
  global.setTimeout = (fn) => { fn(); return 0 }
  t.after(() => { global.setTimeout = originalSetTimeout })

  harness.socketManager._test.setConnectedSocket("client-1", { id: "sock-1" })
  await harness.socketManager.startSenderLoop("client-1")

  const zaddCalls = harness.getZaddCalls().filter(c => c.key === "wa:msglog:client-1")
  assert.equal(zaddCalls.length, 1)

  const entry = JSON.parse(zaddCalls[0].member)
  assert.equal(entry.status, "sent")
  assert.equal(entry.phoneNumber, "9999999999")
  assert.equal(entry.text, "hello")
  assert.equal(entry.fileCount, 0)
  assert.equal(entry.failReason, undefined)
  assert.ok(typeof entry.sentAt === "number")
})

test("deleteClient does not delete the message log key", async (t) => {
  const harness = createSocketManagerHarness()
  t.after(() => harness.restore())

  await harness.socketManager.initClient("client-1")
  await harness.socketManager.deleteClient("client-1")

  const deletedKeys = harness.getDeletedKeys()
  assert.ok(!deletedKeys.includes("wa:msglog:client-1"),
    "wa:msglog:client-1 must not be deleted on deleteClient — TTL handles expiry")
})

test("logMessage errors do not affect message delivery or requeue", async (t) => {
  // If zadd throws, the message must still be requeued (failure path) without crashing the loop
  const harness = createSocketManagerHarness({ sendShouldFail: true })
  t.after(() => harness.restore())

  // Patch the first redis instance's zadd to throw after harness is created
  // We need to intercept at the module level; use the redisInstances reference
  // and override after the module loads
  harness.socketManager._test.resetState()

  const originalSetTimeout = global.setTimeout
  global.setTimeout = (fn) => { fn(); return 0 }
  t.after(() => { global.setTimeout = originalSetTimeout })

  // Corrupt zadd on all redis instances to simulate logging failure
  for (const inst of harness.redisInstances) {
    inst.zadd = async () => { throw new Error("redis zadd error") }
  }

  harness.socketManager._test.setConnectedSocket("client-1", { id: "sock-1" })
  await harness.socketManager.startSenderLoop("client-1")

  // Message should still have been requeued despite logging failure
  assert.equal(harness.getRequeued().length, 1)
  assert.equal(harness.getRequeued()[0].key, "wa:pending:client-1")
})

test("sender-loop retries by re-queueing when send fails after dequeue", async (t) => {
  const harness = createSocketManagerHarness()
  t.after(() => harness.restore())

  harness.socketManager._test.resetState()

  const originalSetTimeout = global.setTimeout
  global.setTimeout = (fn) => {
    fn()
    return 0
  }
  t.after(() => {
    global.setTimeout = originalSetTimeout
  })

  harness.socketManager._test.setConnectedSocket("client-1", { id: "sock-1" })

  const startPromise = harness.socketManager.startSenderLoop("client-1")

  await startPromise

  assert.equal(harness.getQueueBrpopCalls(), 1)
  assert.equal(harness.sentMessages.length, 1)
  assert.equal(harness.sentMessages[0].jid, "919999999999@s.whatsapp.net")
  assert.deepEqual(harness.getRequeued(), [{
    key: "wa:pending:client-1",
    value: JSON.stringify({
      type: "SEND_MESSAGE",
      clientId: "client-1",
      phoneNumber: "9999999999",
      text: "hello",
      files: []
    })
  }])
})
