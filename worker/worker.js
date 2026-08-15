/* Один JSON-документ.
 *
 *   GET  /doc    -> {rev, doc}          — открыто всем, это режим чтения
 *   POST /login  {password} -> {token}  — вход владельца
 *   GET  /me     -> {editor}            — проверка токена
 *   PUT  /doc    + Bearer <token>       — запись, только владельцу
 *                + If-Match: <rev>      — 409, если кто-то записал раньше
 *
 * Пароль на сервере не лежит: хранится PBKDF2-хеш с солью (секрет AUTH).
 * Задать пароль: node set-password.mjs
 *
 * Число итераций берётся из самого секрета, так что его можно поднять, когда
 * вырастет лимит процессорного времени — старые сессии при этом не сломаются.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,PUT,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,if-match",
  "access-control-max-age": "86400",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
  });

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const enc = new TextEncoder();

/* --- пароль -------------------------------------------------------------- */
/* AUTH = "pbkdf2$<iterations>$<saltB64url>$<hashB64url>" */
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
}

/* сравнение за постоянное время: длина ответа не должна зависеть от того,
   на каком байте разошлось */
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const fromB64url = s => Uint8Array.from(
  atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

async function checkPassword(password, stored) {
  const [scheme, iter, saltB64, hashB64] = String(stored).split("$");
  if (scheme !== "pbkdf2") return false;
  const want = fromB64url(hashB64);
  const got = new Uint8Array(await pbkdf2(password, fromB64url(saltB64), Number(iter)));
  return sameBytes(got, want);
}

/* --- сессия -------------------------------------------------------------- */
/* Токен без состояния: <expMs>.<HMAC(expMs)>. Ключ HMAC — сам секрет AUTH,
   поэтому смена пароля разом гасит все выданные сессии. */
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

const SESSION_MS = 120 * 24 * 60 * 60 * 1000;   // 120 дней

async function issueToken(secret) {
  const exp = String(Date.now() + SESSION_MS);
  return exp + "." + b64url(await hmac(secret, exp));
}

async function validToken(secret, token) {
  const [exp, sig] = String(token || "").split(".");
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < Date.now()) return false;
  return sameBytes(fromB64url(sig), await hmac(secret, exp));
}

/* --- защита от перебора пароля ------------------------------------------- */
const RL_MAX = 10, RL_WINDOW = 900;             // 10 попыток за 15 минут

async function rateLimited(env, ip) {
  const k = "rl:" + ip;
  const n = Number(await env.BIKES.get(k)) || 0;
  if (n >= RL_MAX) return true;
  await env.BIKES.put(k, String(n + 1), { expirationTtl: RL_WINDOW });
  return false;
}

/* ------------------------------------------------------------------------- */
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const isEditor = env.AUTH ? await validToken(env.AUTH, bearer) : false;

    if (path === "/login" && req.method === "POST") {
      if (!env.AUTH) return json({ error: "пароль не задан на сервере" }, 503);
      const ip = req.headers.get("cf-connecting-ip") || "?";
      if (await rateLimited(env, ip)) return json({ error: "слишком много попыток, подождите 15 минут" }, 429);
      let body;
      try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      if (!await checkPassword(String(body.password || ""), env.AUTH))
        return json({ error: "неверный пароль" }, 401);
      return json({ token: await issueToken(env.AUTH) });
    }

    if (path === "/me") return json({ editor: isEditor });

    if (path === "/doc" || path === "/") {
      const stored = await env.BIKES.get("doc", { type: "json" });
      const rev = stored ? stored.rev : 0;

      // чтение открыто: посетитель видит те же данные, но не может их менять
      if (req.method === "GET") return json({ rev, doc: stored ? stored.doc : null, editor: isEditor });

      if (req.method === "PUT") {
        if (!isEditor) return json({ error: "нужен вход" }, 401);
        const base = Number(req.headers.get("if-match"));
        if (!Number.isFinite(base) || base !== rev) return json({ error: "conflict", rev }, 409);
        let doc;
        try { doc = await req.json(); } catch { return json({ error: "bad json" }, 400); }
        if (!doc || typeof doc !== "object") return json({ error: "bad doc" }, 400);
        const next = rev + 1;
        await env.BIKES.put("doc", JSON.stringify({ rev: next, doc }));
        return json({ rev: next });
      }
    }

    return json({ error: "not found" }, 404);
  },
};
