import path from "path"
import { fileURLToPath } from "url"
import express from "express"
import basicAuth from "basic-auth"
import Docker from "dockerode"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const distPath = path.resolve(__dirname, "../dist")

const app = express()
const docker = new Docker({ socketPath: "/var/run/docker.sock" })

const DASH_USER = process.env.DASH_USER || "admin"
const DASH_PASS = process.env.DASH_PASS || "admin"
const PORT = Number(process.env.DASH_PORT || 8080)

function authMiddleware(req, res, next) {
  const creds = basicAuth(req)
  if (!creds || creds.name !== DASH_USER || creds.pass !== DASH_PASS) {
    res.set("WWW-Authenticate", "Basic realm=BaileysDashboard")
    return res.status(401).send("Authentication required")
  }
  return next()
}

function matchContainer(name, service) {
  const n = name.replace(/^\//, "")
  return (
    n.includes(`_${service}_`) ||
    n.includes(`-${service}-`) ||
    n === service ||
    n.endsWith(`_${service}_1`) ||
    n.endsWith(`-${service}-1`) ||
    n.endsWith(`${service}_1`) ||
    n.endsWith(`${service}-1`)
  )
}

async function findContainer(service) {
  const containers = await docker.listContainers({ all: true })
  const running = containers.filter((c) => c.State === "running")
  const pool = running.length ? running : containers

  for (const c of pool) {
    if (c.Names && c.Names.some((n) => matchContainer(n, service))) {
      return docker.getContainer(c.Id)
    }
  }

  return null
}

app.use(authMiddleware)
app.use(express.json())

app.get("/api/health", (_req, res) => {
  res.json({ ok: true })
})

app.get("/api/logs", async (req, res) => {
  const service = String(req.query.service || "worker")
  const tail = Math.min(Number(req.query.tail || 200), 2000)

  const allowed = new Set(["worker", "api", "redis", "dashboard"])
  if (!allowed.has(service)) {
    return res.status(400).send("Invalid service")
  }

  try {
    const container = await findContainer(service)
    if (!container) {
      return res.status(404).send(`Container not found for service: ${service}`)
    }

    const stream = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: false
    })

    if (Buffer.isBuffer(stream) || typeof stream === "string") {
      const text = Buffer.isBuffer(stream) ? stream.toString("utf-8") : stream
      return res.type("text/plain").send(text)
    }

    const chunks = []
    stream.on("data", (chunk) => chunks.push(chunk))
    stream.on("end", () => {
      const buf = Buffer.concat(chunks)
      res.type("text/plain").send(buf.toString("utf-8"))
    })
    stream.on("error", (err) => {
      res.status(500).send(`Failed to read logs: ${err && err.message ? err.message : "unknown error"}`)
    })
  } catch (err) {
    res.status(500).send(`Failed to read logs: ${err && err.message ? err.message : "unknown error"}`)
  }
})

app.use(express.static(distPath))
app.get("*", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"))
})

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Dashboard server running on :${PORT}`)
})
