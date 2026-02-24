const fs = require("fs")

function clearSession(clientId) {
  const sessionPath = `/sessions/${clientId}`

  if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true })
    console.log(`🧹 Cleared session for ${clientId}`)
  }
}

module.exports = { clearSession }
