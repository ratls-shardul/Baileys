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
  const [selectedClient, setSelectedClient] = useState("")
  const [logs, setLogs] = useState("")
  const [logService, setLogService] = useState("worker")
  const [logTail, setLogTail] = useState(200)
  const [sendForm, setSendForm] = useState({ clientId: "", phoneNumber: "", text: "" })
  const [newClientId, setNewClientId] = useState("")
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
    await fetch(`${apiBase}/clients/${encodeURIComponent(clientId)}`, { method: "DELETE" })
    await refreshAll()
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
                    <button onClick={() => setSelectedClient(clientId)}>Select</button>
                    <button onClick={() => reconnectClient(clientId)}>Reconnect</button>
                    <button onClick={() => restartClient(clientId, false)}>Restart</button>
                    <button onClick={() => restartClient(clientId, true)}>Reset+Restart</button>
                    <button onClick={() => stopClient(clientId, false)}>Stop</button>
                    <button onClick={() => stopClient(clientId, true)}>Reset+Stop</button>
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
          <div className="section-title">Selected Client</div>
          <div className="meta">
            {selectedClient ? `Selected: ${selectedClient}` : "Select a client to pin here"}
          </div>
          <div className="actions">
            <button disabled={!selectedClient} onClick={() => reconnectClient(selectedClient)}>Reconnect</button>
            <button disabled={!selectedClient} onClick={() => restartClient(selectedClient, false)}>Restart</button>
            <button disabled={!selectedClient} onClick={() => restartClient(selectedClient, true)}>Reset+Restart</button>
            <button disabled={!selectedClient} onClick={() => stopClient(selectedClient, false)}>Stop</button>
            <button disabled={!selectedClient} onClick={() => stopClient(selectedClient, true)}>Reset+Stop</button>
            <button className="danger" disabled={!selectedClient} onClick={() => deleteClient(selectedClient)}>Delete</button>
          </div>
        </div>
      </section>
    </div>
  )
}

export default App
