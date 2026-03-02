const fs = require("fs")
const { clientLog } = require("./logger")

function clearSession(clientId) {
  const sessionPath = `/sessions/${clientId}`

  if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true })
  clientLog(clientId, "info", "🧹 Cleared session")
  }
}

module.exports = { clearSession }
