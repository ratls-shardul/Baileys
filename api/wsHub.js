// No external dependencies needed
const clients = new Map()
// clientId -> Set<WebSocket>

function register(clientId, ws) {
  console.log(`📝 Registering WebSocket for: ${clientId}`)
  
  if (!clients.has(clientId)) {
    clients.set(clientId, new Set())
  }

  const clientSockets = clients.get(clientId)
  clientSockets.add(ws)
  
  console.log(`✅ Total sockets for ${clientId}: ${clientSockets.size}`)

  // Clean up on close
  ws.on("close", () => {
    console.log(`🔌 WebSocket closing for ${clientId}`)
    unregister(clientId, ws)
  })
}

function unregister(clientId, ws) {
  const clientSockets = clients.get(clientId)
  
  if (clientSockets) {
    clientSockets.delete(ws)
    console.log(`🗑️ Removed socket for ${clientId}, remaining: ${clientSockets.size}`)
    
    // Remove entry if no more sockets
    if (clientSockets.size === 0) {
      clients.delete(clientId)
      console.log(`🧹 Cleaned up ${clientId} from registry`)
    }
  }
}

function broadcast(clientId, payload) {
  const clientSockets = clients.get(clientId)

  console.log(`📢 BROADCAST to ${clientId}:`, {
    hasEntry: !!clientSockets,
    socketsCount: clientSockets?.size || 0,
    payload: payload
  })

  if (!clientSockets || clientSockets.size === 0) {
    console.warn(`⚠️ No active WebSockets for ${clientId}`)
    return
  }

  const msg = JSON.stringify(payload)
  let sentCount = 0
  let failedCount = 0

  for (const ws of clientSockets) {
    try {
      // Check readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
      if (ws.readyState === 1) { // OPEN
        ws.send(msg)
        sentCount++
        console.log(`✅ Sent to socket (readyState: ${ws.readyState})`)
      } else {
        console.warn(`⚠️ Socket not ready (readyState: ${ws.readyState})`)
        failedCount++
      }
    } catch (err) {
      console.error(`❌ Failed to send to socket:`, err.message)
      failedCount++
    }
  }

  console.log(`📊 Broadcast complete: ${sentCount} sent, ${failedCount} failed`)
}

function getStats() {
  const stats = {}
  for (const [clientId, sockets] of clients.entries()) {
    stats[clientId] = sockets.size
  }
  return stats
}

module.exports = { 
  register, 
  unregister,
  broadcast,
  getStats
}