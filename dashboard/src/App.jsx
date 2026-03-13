import React, { useEffect, useMemo, useState } from "react"

const DEFAULT_API_BASE = "http://localhost:3000"

function loadApiBase() {
  return localStorage.getItem("apiBase") || DEFAULT_API_BASE
}

function App() {
  const [apiBase, setApiBase] = useState(loadApiBase)
  const [clientStates, setClientStates] = useState({})
  const [activeClients, setActiveClients] = useState([])
  const [wsStats, setWsStats] = useState({})
  const [sendDelay, setSendDelay] = useState({ minMs: 3000, maxMs: 8000, source: "default" })
  const [sendDelayForm, setSendDelayForm] = useState({ minMs: "3000", maxMs: "8000" })
  const [sendDelaySaving, setSendDelaySaving] = useState(false)
  const [sendDelayError, setSendDelayError] = useState("")
  const [logs, setLogs] = useState("")
  const [logService, setLogService] = useState("worker")
  const [logTail, setLogTail] = useState(200)
  const [sendForm, setSendForm] = useState({ clientId: "", phoneNumber: "", text: "" })
  const [newClientId, setNewClientId] = useState("")
  const [queueLookupId, setQueueLookupId] = useState("")
  const [queueClientId, setQueueClientId] = useState("")
  const [queueData, setQueueData] = useState(null)
  const [queueLoading, setQueueLoading] = useState(false)
  const [queueError, setQueueError] = useState("")
  const [loading, setLoading] = useState(false)
  const [lastRefresh, setLastRefresh] = useState(null)

  const clients = useMemo(() => Object.keys(clientStates || {}), [clientStates])

  async function apiGet(path) {
    const res = await fetch(`${apiBase}${path}`)
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`)
    return res.json()
  }

  async function apiPost(path, body) {
    const res = await fetch(`${apiBase}${path}` , {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {})
    })
    if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`)
    return res.json()
  }

  async function apiDelete(path) {
    const res = await fetch(`${apiBase}${path}`, { method: "DELETE" })
    if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`)
    return res.json()
  }

  async function refreshAll() {
    setLoading(true)
    try {
      const [states, active, ws] = await Promise.all([
        apiGet("/debug/client-states"),
        apiGet("/debug/active-clients"),
        apiGet("/debug/ws-stats")
      ])
      setClientStates(states.states || {})
      setActiveClients(active.active || [])
      setWsStats(ws.websockets || {})
      setLastRefresh(new Date())
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refreshAll()
    const id = setInterval(refreshAll, 5000)
    return () => clearInterval(id)
  }, [apiBase])

  useEffect(() => {
    localStorage.setItem("apiBase", apiBase)
  }, [apiBase])

  useEffect(() => {
    let cancelled = false

    async function loadSendDelay() {
      try {
        const data = await apiGet("/config/send-delay")
        if (cancelled) return
        setSendDelay(data)
        setSendDelayForm({
          minMs: String(data.minMs ?? 3000),
          maxMs: String(data.maxMs ?? 8000)
        })
        setSendDelayError("")
      } catch (err) {
        if (!cancelled) {
          setSendDelayError("Failed to load send delay config")
        }
      }
    }

    loadSendDelay()
    return () => {
      cancelled = true
    }
  }, [apiBase])

  async function fetchLogs() {
    try {
      const res = await fetch(`/api/logs?service=${encodeURIComponent(logService)}&tail=${logTail}`)
      if (!res.ok) throw new Error("logs fetch failed")
      const text = await res.text()
      setLogs(text)
    } catch (err) {
      setLogs("Failed to load logs. Check dashboard server and docker socket access.")
    }
  }

  async function createClient() {
    if (!newClientId) return
    await apiPost(`/clients/${encodeURIComponent(newClientId)}`)
    setNewClientId("")
    await refreshAll()
  }

  async function reconnectClient(clientId) {
    await apiPost(`/clients/${encodeURIComponent(clientId)}/reconnect`)
    await refreshAll()
  }

  async function restartClient(clientId, resetSession) {
    await apiPost(`/clients/${encodeURIComponent(clientId)}/restart`, { resetSession })
    await refreshAll()
  }

  async function stopClient(clientId, resetSession) {
    await apiPost(`/clients/${encodeURIComponent(clientId)}/stop`, { resetSession })
    await refreshAll()
  }

  async function deleteClient(clientId) {
    await apiDelete(`/clients/${encodeURIComponent(clientId)}`)
    await refreshAll()
    if (queueClientId === clientId) {
      setQueueClientId("")
      setQueueData(null)
      setQueueError("")
    }
  }

  async function loadQueue(clientId) {
    if (!clientId) return
    setQueueClientId(clientId)
    setQueueLookupId(clientId)
    setQueueLoading(true)
    setQueueError("")
    try {
      const data = await apiGet(`/clients/${encodeURIComponent(clientId)}/queue?limit=100`)
      setQueueData(data)
    } catch (err) {
      setQueueData(null)
      setQueueError(`Failed to load queue for ${clientId}`)
    } finally {
      setQueueLoading(false)
    }
  }

  async function clearQueue(clientId, confirm = true) {
    if (confirm && !window.confirm(`Clear all pending messages for ${clientId}?`)) {
      return
    }
    setQueueLoading(true)
    setQueueError("")
    try {
      await apiDelete(`/clients/${encodeURIComponent(clientId)}/queue`)
      await loadQueue(clientId)
    } catch (err) {
      setQueueError(`Failed to clear queue for ${clientId}`)
      setQueueLoading(false)
    }
  }

  async function sendTestMessage() {
    if (!sendForm.clientId || !sendForm.phoneNumber || !sendForm.text) return
    await apiPost("/messages/send", {
      clientId: sendForm.clientId,
      phoneNumber: sendForm.phoneNumber,
      text: sendForm.text,
      files: []
    })
    setSendForm({ clientId: "", phoneNumber: "", text: "" })
  }

  async function saveSendDelay() {
    setSendDelaySaving(true)
    setSendDelayError("")
    try {
      const data = await apiPost("/config/send-delay", {
        minMs: Number(sendDelayForm.minMs),
        maxMs: Number(sendDelayForm.maxMs)
      })
      setSendDelay({
        minMs: data.minMs,
        maxMs: data.maxMs,
        source: "redis"
      })
      setSendDelayForm({
        minMs: String(data.minMs),
        maxMs: String(data.maxMs)
      })
    } catch (err) {
      setSendDelayError("Failed to save send delay config")
    } finally {
      setSendDelaySaving(false)
    }
  }

  const sortedClients = [...clients].sort((a, b) => a.localeCompare(b))

  return (
    <div className="page">
      <header className="hero">
        <div>
          <div className="eyebrow">Baileys Ops</div>
          <h1>Socket Control Center</h1>
          <p>Manage clients, sessions, and stdout logs on a single EC2 node.</p>
        </div>
        <div className="card glow">
          <div className="label">API Base</div>
          <input
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            placeholder={DEFAULT_API_BASE}
          />
          <div className="meta">
            Last refresh: {lastRefresh ? lastRefresh.toLocaleTimeString() : "never"}
          </div>
        </div>
      </header>

      <section className="grid">
        <div className="card">
          <div className="section-title">Overview</div>
          <div className="stat-row">
            <div className="stat">
              <div className="stat-label">Known Clients</div>
              <div className="stat-value">{clients.length}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Active Sockets</div>
              <div className="stat-value">{activeClients.length}</div>
            </div>
            <div className="stat">
              <div className="stat-label">WS Connections</div>
              <div className="stat-value">{Object.values(wsStats).reduce((a, b) => a + b, 0)}</div>
            </div>
          </div>
          <button onClick={refreshAll} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh Now"}
          </button>
        </div>

        <div className="card">
          <div className="section-title">Create Client</div>
          <input
            value={newClientId}
            onChange={(e) => setNewClientId(e.target.value)}
            placeholder="client-123"
          />
          <button onClick={createClient}>Create</button>
        </div>

        <div className="card">
          <div className="section-title">Send Test Message</div>
          <input
            value={sendForm.clientId}
            onChange={(e) => setSendForm({ ...sendForm, clientId: e.target.value })}
            placeholder="clientId"
          />
          <input
            value={sendForm.phoneNumber}
            onChange={(e) => setSendForm({ ...sendForm, phoneNumber: e.target.value })}
            placeholder="phoneNumber"
          />
          <input
            value={sendForm.text}
            onChange={(e) => setSendForm({ ...sendForm, text: e.target.value })}
            placeholder="message text"
          />
          <button onClick={sendTestMessage}>Queue Message</button>
        </div>

        <div className="card">
          <div className="section-title">Send Delay</div>
          <input
            type="number"
            min="500"
            max="120000"
            value={sendDelayForm.minMs}
            onChange={(e) => setSendDelayForm({ ...sendDelayForm, minMs: e.target.value })}
            placeholder="min delay ms"
          />
          <input
            type="number"
            min="500"
            max="120000"
            value={sendDelayForm.maxMs}
            onChange={(e) => setSendDelayForm({ ...sendDelayForm, maxMs: e.target.value })}
            placeholder="max delay ms"
          />
          <div className="meta">
            Active: {sendDelay.minMs}ms - {sendDelay.maxMs}ms ({sendDelay.source})
          </div>
          {sendDelayError && <div className="queue-error">{sendDelayError}</div>}
          <button onClick={saveSendDelay} disabled={sendDelaySaving}>
            {sendDelaySaving ? "Saving..." : "Save Delay"}
          </button>
        </div>
      </section>

      <section className="grid wide">
        <div className="card">
          <div className="section-title">Clients</div>
          <div className="list">
            {sortedClients.length === 0 && <div className="empty">No clients yet</div>}
            {sortedClients.map((clientId) => {
              const state = clientStates[clientId]
              const wsCount = wsStats[clientId] || 0
              const isActive = activeClients.includes(clientId)
              return (
                <div key={clientId} className="row">
                  <div className="row-main">
                    <div className="row-title">{clientId}</div>
                    <div className="row-meta">
                      State: {state || "UNKNOWN"} · Active: {isActive ? "yes" : "no"} · WS: {wsCount}
                    </div>
                  </div>
                  <div className="row-actions">
                    <button
                      className={queueClientId === clientId ? "active-action" : ""}
                      onClick={() => loadQueue(clientId)}
                    >
                      View Queue
                    </button>
                    <button onClick={() => clearQueue(clientId, true)}>Clear Queue</button>
                    <button onClick={() => reconnectClient(clientId)}>Reconnect</button>
                    <button className="btn-restart" onClick={() => restartClient(clientId, false)}>Restart</button>
                    <button className="btn-restart" onClick={() => restartClient(clientId, true)}>Reset+Restart</button>
                    <button className="btn-stop" onClick={() => stopClient(clientId, false)}>Stop</button>
                    <button className="btn-stop" onClick={() => stopClient(clientId, true)}>Reset+Stop</button>
                    <button className="danger" onClick={() => deleteClient(clientId)}>Delete</button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="card">
          <div className="section-title">Logs (stdout)</div>
          <div className="controls">
            <select value={logService} onChange={(e) => setLogService(e.target.value)}>
              <option value="worker">worker</option>
              <option value="api">api</option>
              <option value="redis">redis</option>
              <option value="dashboard">dashboard</option>
            </select>
            <input
              type="number"
              min="10"
              max="2000"
              value={logTail}
              onChange={(e) => setLogTail(Number(e.target.value))}
            />
            <button onClick={fetchLogs}>Load Logs</button>
          </div>
          <pre className="log-box">{logs || ""}</pre>
        </div>
      </section>

      <section className="grid">
        <div className="card">
          <div className="section-title">Client Queue</div>
          <div className="queue-lookup">
            <input
              value={queueLookupId}
              onChange={(e) => setQueueLookupId(e.target.value)}
              placeholder="Enter clientId to view queue (including non-created clients)"
            />
            <button onClick={() => loadQueue(queueLookupId.trim())} disabled={!queueLookupId.trim() || queueLoading}>
              View Queue
            </button>
            <button onClick={() => clearQueue(queueLookupId.trim(), true)} disabled={!queueLookupId.trim() || queueLoading}>
              Clear Queue
            </button>
          </div>
          {!queueClientId && <div className="empty">Pick a client and click View Queue.</div>}
          {queueClientId && (
            <>
              <div className="queue-header">
                <div className="meta">
                  Client: {queueClientId} · Total queued: {queueData?.total ?? "-"} · Showing: {queueData?.returned ?? 0}
                </div>
                <div className="queue-actions">
                  <button onClick={() => loadQueue(queueClientId)} disabled={queueLoading}>
                    {queueLoading ? "Loading..." : "Refresh Queue"}
                  </button>
                  <button onClick={() => clearQueue(queueClientId, true)} disabled={queueLoading}>
                    Clear Queue
                  </button>
                </div>
              </div>
              {queueError && <div className="queue-error">{queueError}</div>}
              <div className="queue-list">
                {!queueLoading && queueData?.messages?.length === 0 && (
                  <div className="empty">Queue is empty.</div>
                )}
                {queueData?.messages?.map((entry) => {
                  const p = entry.parsed || {}
                  return (
                    <div key={`${entry.index}-${entry.raw?.slice(0, 20)}`} className="queue-item">
                      <div className="queue-item-top">
                        <strong>#{entry.index + 1}</strong>
                        <span className="meta">
                          {p.type || "UNKNOWN"} · {p.phoneNumber || "n/a"} · files: {Array.isArray(p.files) ? p.files.length : 0}
                        </span>
                      </div>
                      <div className="queue-text">{p.text || "(no text)"}</div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
          <div className="meta">
            Queue panel is read-only for payload details; use Clear Queue to drop pending jobs.
          </div>
        </div>
      </section>
    </div>
  )
}

export default App
