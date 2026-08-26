/**
 * Гараж — сервер для VPS.
 * Порт с Cloudflare Worker: тот же договор, та же модель доступа.
 *   GET  /api/doc              — открыто всем, это режим чтения
 *   POST /api/login {password} — вход владельца, отдаёт токен
 *   GET  /api/me               — проверка токена
 *   PUT  /api/doc + Bearer     — запись, только владельцу
 *                 + If-Match   — 409, если кто-то записал раньше
 * Отличия от Worker: состояние в файле вместо KV, TLS снимает nginx,
 * страница отдаётся этим же процессом. Зависимостей нет — только Node.
 */
"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR || "/var/lib/bikes";
const APP_DIR = process.env.APP_DIR || __dirname;
const STATE_FILE = path.join(DATA_DIR, "state.json");
const AUTH = process.env.AUTH;              // pbkdf2$<iter>$<salt>$<hash>

const SESSION_MS = 120 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const BODY_LIMIT = 12 * 1024 * 1024;        // документ с фотографиями тяжёлый

const INDEX = fs.readFileSync(path.join(APP_DIR, "index.html"));
const FONT = (() => { try { return fs.readFileSync(path.join(APP_DIR, "assets/Unbounded.woff2")); } catch { return null; } })();

/* ---------- пароль ---------- */
/* Итерации берутся из самой строки: их можно поднять, не ломая формат. */
const pbkdf2 = (password, salt, iter) =>
  new Promise((res, rej) =>
    crypto.pbkdf2(password, salt, iter, 32, "sha256", (e, k) => (e ? rej(e) : res(k))));

function safeEqual(a, b) {
  const A = Buffer.from(a), B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

const fromB64url = s => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const b64url = b => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function checkPassword(password) {
  const [scheme, iter, saltB64, hashB64] = String(AUTH).split("$");
  if (scheme !== "pbkdf2") return false;
  const want = fromB64url(hashB64);
  const got = await pbkdf2(password, fromB64url(saltB64), Number(iter));
  return safeEqual(got, want);
}

/* Токен без состояния: <expMs>.<HMAC>. Ключ — сам AUTH, поэтому смена
   пароля разом гасит все выданные сессии. */
const hmac = msg => crypto.createHmac("sha256", AUTH).update(msg).digest();

const issueToken = () => {
  const exp = String(Date.now() + SESSION_MS);
  return exp + "." + b64url(hmac(exp));
};

function validToken(token) {
  const [exp, sig] = String(token || "").split(".");
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < Date.now()) return false;
  try { return safeEqual(fromB64url(sig), hmac(exp)); } catch { return false; }
}

/* ---------- состояние ---------- */
let state = { rev: 0, doc: null };

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (s && typeof s === "object" && Number.isFinite(s.rev)) state = s;
    console.log(`состояние загружено: ревизия ${state.rev}`);
  } catch (e) {
    if (e.code !== "ENOENT") console.error("состояние повреждено, начинаю с пустого:", e.message);
  }
}

// Пишем во временный файл и переименовываем: падение на середине не портит старый.
let writeChain = Promise.resolve();
function saveState() {
  writeChain = writeChain.then(async () => {
    const tmp = `${STATE_FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(state), "utf8");
    await fsp.rename(tmp, STATE_FILE);
    // Ежедневная копия — на случай, если клиент запишет пустой документ.
    const day = new Date().toISOString().slice(0, 10);
    const bak = path.join(DATA_DIR, "backups", `state-${day}.json`);
    if (!fs.existsSync(bak)) await fsp.copyFile(STATE_FILE, bak);
  }).catch(e => console.error("не удалось сохранить состояние:", e.message));
  return writeChain;
}

/* ---------- защита от перебора пароля ---------- */
const attempts = new Map();
const rateLimited = ip => {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() > a.until) { attempts.delete(ip); return false; }
  return a.n >= MAX_ATTEMPTS;
};
function noteFailure(ip) {
  const a = attempts.get(ip);
  if (a && Date.now() <= a.until) a.n++;
  else attempts.set(ip, { n: 1, until: Date.now() + ATTEMPT_WINDOW_MS });
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of attempts) if (now > a.until) attempts.delete(ip);
}, 60_000).unref();

/* ---------- HTTP ---------- */
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error("слишком большой запрос")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("неверный JSON")); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://local");
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const ip = (req.headers["x-real-ip"] || req.socket.remoteAddress || "?").toString();
    const editor = AUTH ? validToken((req.headers.authorization || "").replace(/^Bearer\s+/i, "")) : false;

    if (p === "/api/login" && req.method === "POST") {
      if (!AUTH) return send(res, 503, { error: "пароль не задан на сервере" });
      if (rateLimited(ip)) return send(res, 429, { error: "слишком много попыток, подождите 15 минут" });
      let body;
      try { body = await readBody(req); } catch { return send(res, 400, { error: "bad json" }); }
      if (!await checkPassword(String(body.password || ""))) {
        noteFailure(ip);
        return send(res, 401, { error: "неверный пароль" });
      }
      attempts.delete(ip);
      return send(res, 200, { token: issueToken() });
    }

    if (p === "/api/me") return send(res, 200, { editor });

    if (p === "/api/doc") {
      if (req.method === "GET") return send(res, 200, { rev: state.rev, doc: state.doc, editor });
      if (req.method === "PUT") {
        if (!editor) return send(res, 401, { error: "нужен вход" });
        const base = Number(req.headers["if-match"]);
        if (!Number.isFinite(base) || base !== state.rev) return send(res, 409, { error: "conflict", rev: state.rev });
        let doc;
        try { doc = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
        if (!doc || typeof doc !== "object") return send(res, 400, { error: "bad doc" });
        state = { rev: state.rev + 1, doc };
        await saveState();
        return send(res, 200, { rev: state.rev });
      }
    }

    if (p === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }

    if (p === "/assets/Unbounded.woff2" && FONT) {
      res.writeHead(200, {
        "content-type": "font/woff2",
        "content-length": FONT.length,
        "cache-control": "public, max-age=31536000, immutable",
      });
      return res.end(FONT);
    }

    if (p.startsWith("/api/")) return send(res, 404, { error: "not found" });

    // всё остальное — сама страница: разделы живут в hash, отдельных путей нет
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": INDEX.length,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(INDEX);
  } catch (e) {
    console.error("необработанная ошибка:", e);
    if (!res.headersSent) send(res, 500, { error: "внутренняя ошибка" });
    else res.end();
  }
});

fs.mkdirSync(path.join(DATA_DIR, "backups"), { recursive: true });
loadState();
server.listen(PORT, HOST, () => console.log(`слушаю http://${HOST}:${PORT}`));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => writeChain.finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
