const clients = new Map()
// clientId -> Set<ws>

function register(clientId, ws) {
  if (!clients.has(clientId)) {
    clients.set(clientId, new Set())
  }

  clients.get(clientId).add(ws)

  ws.on("close", () => {
    clients.get(clientId)?.delete(ws)
    if (clients.get(clientId)?.size === 0) {
      clients.delete(clientId)
    }
  })
}

function broadcast(clientId, payload) {
  const sockets = clients.get(clientId)
  if (!sockets) return

  const msg = JSON.stringify(payload)

  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(msg)
    }
  }
}

module.exports = { register, broadcast }
