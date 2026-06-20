const express = require("express");
const path    = require("path");
const fs      = require("fs");
const crypto  = require("crypto");
const { MongoClient } = require("mongodb");

const PORT      = process.env.PORT || 3000;
const BASE      = __dirname;
const ADMIN_PWD = process.env.ADMIN_PWD || "mvhtadobx";
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("[FATAL] Variable MONGO_URI manquante.");
  process.exit(1);
}

const mongoClient = new MongoClient(MONGO_URI, {
  serverSelectionTimeoutMS: 8000,
  connectTimeoutMS: 8000,
});
let db;

async function dbGet(collection, id) {
  const doc = await db.collection(collection).findOne({ _id: id });
  return doc ? doc.data : null;
}
async function dbSet(collection, id, data) {
  await db.collection(collection).updateOne(
    { _id: id },
    { $set: { data, updatedAt: new Date() } },
    { upsert: true }
  );
}

// ── Tokens de session ─────────────────────────────────────────────────────
const SESSION_TTL   = 24 * 60 * 60 * 1000;
const adminSessions = new Map();

function genToken() { return crypto.randomBytes(32).toString("hex"); }
function validAdmin(token) {
  if (!token || !adminSessions.has(token)) return false;
  if (Date.now() > adminSessions.get(token)) { adminSessions.delete(token); return false; }
  return true;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".gif":  "image/gif",
  ".ico":  "image/x-icon",
  ".webp": "image/webp",
};

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.get("/health", (req, res) => res.json({ ok: true }));

// ── GET config ────────────────────────────────────────────────────────────
app.get("/api/cfg", async (req, res) => {
  try { res.json(await dbGet("config", "cfg")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET state ─────────────────────────────────────────────────────────────
app.get("/api/state", async (req, res) => {
  try { res.json(await dbGet("state", "state")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Auth admin ────────────────────────────────────────────────────────────
app.post("/api/admin-auth", (req, res) => {
  const { pwd } = req.body;
  if (!pwd || pwd !== ADMIN_PWD) return res.status(403).json({ error: "WRONG_PASSWORD" });
  const token = genToken();
  adminSessions.set(token, Date.now() + SESSION_TTL);
  res.json({ token });
});

// ── POST config (admin) — met aussi a jour les balances ───────────────────
app.post("/api/cfg", async (req, res) => {
  try {
    const { token, cfg } = req.body;
    if (!validAdmin(token)) return res.status(403).json({ error: "UNAUTHORIZED" });
    if (!cfg || !cfg.accounts || !cfg.pin) return res.status(400).json({ error: "INVALID_CFG" });

    // Sauvegarder la config
    await dbSet("config", "cfg", cfg);

    // Balances : les soldes admin remplacent la state
    const newBalances = {};
    cfg.accounts.forEach(a => { newBalances[a.id] = a.balance; });

    const currentState = await dbGet("state", "state");
    const existingTransfers = currentState?.transfers || [];

    // Distinguer les virements utilisateur (id timestamp > 1e10) des seed admin (id petit entier)
    const userTransfers = existingTransfers.filter(t => t.id > 1e10);
    const seedTransfers = cfg.seedTransfers || [];

    // Fusionner : seed admin + virements utilisateur (sans doublons)
    const seedIds = new Set(seedTransfers.map(t => t.id));
    const merged = [
      ...seedTransfers,
      ...userTransfers.filter(t => !seedIds.has(t.id))
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    await dbSet("state", "state", {
      transfers: merged,
      balances: newBalances
    });

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST state (libre) ────────────────────────────────────────────────────
app.post("/api/state", async (req, res) => {
  try {
    const { transfers, balances } = req.body;
    if (!transfers || balances === undefined) return res.status(400).json({ error: "INVALID_STATE" });
    await dbSet("state", "state", { transfers, balances });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Fichiers statiques ────────────────────────────────────────────────────
app.use((req, res) => {
  let filePath = req.path;
  if (filePath === "/" || filePath === "") filePath = "/index.html";
  else if (filePath === "/admin") filePath = "/admin.html";
  const fullPath = path.join(BASE, filePath);
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    const ext = path.extname(fullPath).toLowerCase();
    res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
    return res.send(fs.readFileSync(fullPath));
  }
  res.status(404).send("Not Found");
});

// ── Démarrage ─────────────────────────────────────────────────────────────
async function startServer() {
  try {
    console.log("[MongoDB] Connexion en cours...");
    await mongoClient.connect();
    db = mongoClient.db("bankdb");
    console.log("[MongoDB] Connecté ✓");
    app.listen(PORT, "0.0.0.0", () => console.log(`[Server] Port ${PORT}`));
  } catch (e) {
    console.error("[FATAL] Impossible de se connecter à MongoDB :", e.message);
    process.exit(1);
  }
}
startServer();
