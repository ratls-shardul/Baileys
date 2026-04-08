const path = require("path")
const test = require("node:test")
const assert = require("node:assert/strict")

const { loadWithMocks, clearModule } = require("../../test/loadWithMocks")

function createSocketManagerHarness() {
  const stateTransitions = []
  const clearedSessions = []
  const redisInstances = []
  const fakeSockets = []
  const timeoutCalls = []
  const sentMessages = []
  let queueBrpopCalls = 0
  let requeued = []
  let stopLoopAfterRequeue = null

  class FakeRedis {
    constructor() {
      this.events = {}
      this.xaddCalls = []
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

    async sadd() {
      return 1
    }

    async srem() {
      return 1
    }

    async set() {
      return "OK"
    }

    async del() {
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
        throw new Error("send failed")
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
