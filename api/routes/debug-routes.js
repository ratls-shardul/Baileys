const redis = require("../redis")
const { getStats } = require("../wsHub")

module.exports = async function (fastify) {
  
  // Debug endpoint to check WebSocket connections
  fastify.get("/debug/ws-stats", async () => {
    return {
      websockets: getStats(),
      timestamp: new Date().toISOString()
    }
  })

  // Debug endpoint to check client states
  fastify.get("/debug/client-states", async () => {
    const states = await redis.hgetall("wa:clients:state")
    return {
      states,
      timestamp: new Date().toISOString()
    }
  })

  // Debug endpoint to check active sockets (worker-initialized clients)
  fastify.get("/debug/active-clients", async () => {
    const active = await redis.smembers("wa:clients:active")
    return {
      active,
      count: active.length,
      timestamp: new Date().toISOString()
    }
  })

  // Debug endpoint to trigger a test broadcast
  fastify.post("/debug/test-broadcast/:clientId", async (req, res) => {
    const { clientId } = req.params

    const event = {
      type: "test",
      clientId,
      message: "This is a test broadcast",
      timestamp: new Date().toISOString()
    }

    await redis.xadd(
      "wa:events:stream",
      "*",
      "data",
      JSON.stringify(event)
    )

    return { 
      ok: true, 
      message: `Test broadcast sent for ${clientId}` 
    }
  })

  // Debug endpoint to check QR codes
  fastify.get("/debug/qr/:clientId", async (req, res) => {
    const { clientId } = req.params
    const qr = await redis.get(`wa:qr:${clientId}`)
    
    return {
      clientId,
      hasQr: !!qr,
      qr: qr ? qr.substring(0, 50) + "..." : null
    }
  })

  // Debug endpoint to check pending messages
  fastify.get("/debug/pending/:clientId", async (req, res) => {
    const { clientId } = req.params
    const queueLength = await redis.llen(`wa:pending:${clientId}`)
    
    return {
      clientId,
      pendingMessages: queueLength
    }
  })
}
