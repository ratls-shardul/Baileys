const Redis = require("ioredis")
const { broadcast } = require("./wsHub")
const { info, warn, error, debug } = require("./logger")

let redis = new Redis({
  host: process.env.REDIS_HOST || "redis",
  port: 6379,
  retryStrategy(times) {
    return Math.min(times * 100, 2000)
  }
})

// Configuration
const STREAM_KEY = 'wa:events:stream'
const CONSUMER_GROUP = 'api-consumers'
const CONSUMER_NAME = `api-${process.pid}-${Date.now()}`
const DLQ_STREAM_KEY = process.env.WA_EVENTS_DLQ_STREAM || "wa:events:dlq"
const POISON_THRESHOLD = Number(process.env.WA_EVENTS_POISON_THRESHOLD || 5)
const AUTOCLAIM_MIN_IDLE_MS = Number(process.env.WA_EVENTS_AUTOCLAIM_MIN_IDLE_MS || 60000)
const AUTOCLAIM_BATCH_SIZE = Number(process.env.WA_EVENTS_AUTOCLAIM_BATCH_SIZE || 50)

let isConsuming = false
let consumerRunning = false
const messageFailures = new Map()

/**
 * Initialize the consumer group
 * Creates the stream and consumer group if they don't exist
 */
async function initializeConsumerGroup() {
  try {
    await redis.xgroup(
      'CREATE',
      STREAM_KEY,
      CONSUMER_GROUP,
      '$',
      'MKSTREAM'
    )
  } catch (err) {
    if (err.message.includes('BUSYGROUP')) {
      return
    } else {
      error(`❌ Failed to create consumer group:`, err && err.message ? err.message : err)
      throw err
    }
  }
}

/**
 * Process a single message from the stream
 */
function fieldsToObject(fields) {
  const obj = {}
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1]
  }
  return obj
}

async function processMessage(messageId, fields) {
  try {
    // Fields is an array: ['data', '{"type":"status",...}']
    const eventDataIndex = fields.indexOf('data')
    if (eventDataIndex === -1 || eventDataIndex + 1 >= fields.length) {
      error(`❌ Invalid message format, no 'data' field:`, fields)
      return { ok: false, error: "Invalid message format: missing data field" }
    }
    
    const eventData = fields[eventDataIndex + 1]
    const event = JSON.parse(eventData)
    if (!event || typeof event !== "object" || !event.clientId || !event.type) {
      return { ok: false, error: "Invalid event payload shape" }
    }
    broadcast(event.clientId, event)
    
    return { ok: true }
  } catch (err) {
    const reason = err && err.message ? err.message : String(err)
    error(`❌ Failed to process message ${messageId}:`, reason)
    return { ok: false, error: reason }
  }
}

/**
 * Acknowledge a message (remove from pending)
 */
async function acknowledgeMessage(messageId) {
  try {
    const result = await redis.xack(STREAM_KEY, CONSUMER_GROUP, messageId)
    if (result !== 1) {
      warn(`⚠️ Message acknowledge returned ${result}: ${messageId}`)
    }
    return result
  } catch (err) {
    error(`❌ Failed to acknowledge message ${messageId}:`, err && err.message ? err.message : err)
    return 0
  }
}

async function sendToDlq(messageId, fields, reason) {
  try {
    const payload = {
      sourceStream: STREAM_KEY,
      consumerGroup: CONSUMER_GROUP,
      consumerName: CONSUMER_NAME,
      messageId,
      reason,
      failedAt: new Date().toISOString(),
      fields: fieldsToObject(fields)
    }
    await redis.xadd(DLQ_STREAM_KEY, "*", "data", JSON.stringify(payload))
  } catch (err) {
    error(`❌ Failed to write message ${messageId} to DLQ:`, err && err.message ? err.message : err)
  }
}

async function handleProcessResult(messageId, fields, result, source = "new") {
  if (result.ok) {
    messageFailures.delete(messageId)
    await acknowledgeMessage(messageId)
    return true
  }

  const attempts = (messageFailures.get(messageId) || 0) + 1
  messageFailures.set(messageId, attempts)

  if (attempts >= POISON_THRESHOLD) {
    warn(`☠️ Poison message moved to DLQ (${source}) after ${attempts} attempts: ${messageId}`)
    await sendToDlq(messageId, fields, result.error || "unknown")
    await acknowledgeMessage(messageId)
    messageFailures.delete(messageId)
    return false
  }

  warn(`⚠️ Message processing failed (${source}) [attempt ${attempts}/${POISON_THRESHOLD}]: ${messageId}`)
  return false
}

/**
 * Process any pending messages that weren't acknowledged
 * This handles messages that were delivered but not processed due to crashes
 */
async function processPendingMessages() {
  try {
    const pending = await redis.xreadgroup(
      'GROUP', CONSUMER_GROUP, CONSUMER_NAME,
      'COUNT', 10,
      'STREAMS', STREAM_KEY, '0'
    )
    
    if (!pending || pending.length === 0) {
      return 0
    }
    
    let processed = 0
    for (const [stream, entries] of pending) {
      for (const [messageId, fields] of entries) {
        const result = await processMessage(messageId, fields)
        const ok = await handleProcessResult(messageId, fields, result, "own-pending")
        if (ok) processed++
      }
    }
    return processed
  } catch (err) {
    error(`❌ Error processing pending messages:`, err && err.message ? err.message : err)
    return 0
  }
}

async function claimAndProcessStalePendingMessages() {
  try {
    let startId = "0-0"
    let claimed = 0

    while (true) {
      const result = await redis.xautoclaim(
        STREAM_KEY,
        CONSUMER_GROUP,
        CONSUMER_NAME,
        AUTOCLAIM_MIN_IDLE_MS,
        startId,
        "COUNT",
        AUTOCLAIM_BATCH_SIZE
      )

      const nextStartId = result && result[0] ? result[0] : "0-0"
      const entries = result && Array.isArray(result[1]) ? result[1] : []

      if (!entries.length) break

      for (const [messageId, fields] of entries) {
        claimed++
        const processResult = await processMessage(messageId, fields)
        await handleProcessResult(messageId, fields, processResult, "autoclaim")
      }

      if (nextStartId === startId) break
      startId = nextStartId
    }
    return claimed
  } catch (err) {
    error(`❌ Error during XAUTOCLAIM recovery:`, err && err.message ? err.message : err)
    return 0
  }
}

/**
 * Main consumer loop
 * Continuously reads new messages from the stream
 */
async function startConsumer() {
  if (consumerRunning) {
    warn(`⚠️ Consumer already running`)
    return
  }
  
  consumerRunning = true
  info(`🚀 Starting Redis Streams consumer`)
  
  try {
    // Initialize consumer group
    await initializeConsumerGroup()
    
    // Process any pending messages first
    await processPendingMessages()
    await claimAndProcessStalePendingMessages()
    
    info(`👂 Listening for new messages on stream: ${STREAM_KEY}`)
    isConsuming = true
    
    // Main consumer loop
    while (consumerRunning) {
      try {
        const messages = await redis.xreadgroup(
          'GROUP', CONSUMER_GROUP, CONSUMER_NAME,
          'BLOCK', 1000,
          'COUNT', 10,
          'STREAMS', STREAM_KEY, '>'
        )
        
        if (!messages || messages.length === 0) {
          continue
        }
        
        for (const [stream, entries] of messages) {
          for (const [messageId, fields] of entries) {
            const result = await processMessage(messageId, fields)
            await handleProcessResult(messageId, fields, result, "new")
          }
        }
        
      } catch (err) {
        if (err.message && err.message.includes('NOGROUP')) {
          error(`❌ Consumer group disappeared, reinitializing...`)
          await initializeConsumerGroup()
        } else if (err.message && err.message.includes('timeout')) {
          continue
        } else if (err.message && err.message.includes('ECONNREFUSED')) {
          error(`❌ Redis connection refused, retrying in 2s...`)
          await new Promise(resolve => setTimeout(resolve, 2000))
        } else {
          error(`❌ Error in consumer loop:`, err.message)
        }

        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    
  } catch (err) {
    error(`❌ Stream consumer crashed:`, err && err.message ? err.message : err)
    consumerRunning = false
    isConsuming = false
    throw err
  }
}

/**
 * Stop the consumer gracefully
 */
async function stopConsumer() {
  info(`🛑 Stopping consumer: ${CONSUMER_NAME}`)
  consumerRunning = false
  isConsuming = false
  
  try {
    await redis.quit()
    info(`✅ Consumer stopped cleanly`)
  } catch (err) {
    error(`❌ Error stopping consumer:`, err && err.message ? err.message : err)
  }
}

/**
 * Get consumer status
 */
function getStatus() {
  return {
    isConsuming,
    consumerRunning,
    consumerName: CONSUMER_NAME,
    consumerGroup: CONSUMER_GROUP,
    streamKey: STREAM_KEY
  }
}

// Handle graceful shutdown
process.on('SIGTERM', stopConsumer)
process.on('SIGINT', stopConsumer)

module.exports = {
  startConsumer,
  stopConsumer,
  getStatus,
  isConsuming: () => isConsuming,
  _test: {
    fieldsToObject,
    processMessage,
    handleProcessResult,
    resetState() {
      messageFailures.clear()
      isConsuming = false
      consumerRunning = false
    },
    setRedisClient(client) {
      redis = client
    }
  }
}
