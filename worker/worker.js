/* One JSON document, two verbs.
 *
 * GET  /doc  -> {rev, doc}
 * PUT  /doc  with If-Match: <rev>  -> {rev} | 409 if someone else wrote first
 *
 * The bearer key guards this document and nothing else — it is not a GitHub
 * token, it cannot touch the repo or the account. Set it with:
 *   wrangler secret put SYNC_KEY
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,PUT,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,if-match",
  "access-control-max-age": "86400",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
  });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    const auth = req.headers.get("authorization") || "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!env.SYNC_KEY || key !== env.SYNC_KEY) return json({ error: "unauthorized" }, 401);

    const stored = await env.BIKES.get("doc", { type: "json" });
    const rev = stored ? stored.rev : 0;

    if (req.method === "GET") return json({ rev, doc: stored ? stored.doc : null });

    if (req.method === "PUT") {
      // optimistic concurrency: a device that based its edit on an older
      // revision is told to refetch instead of overwriting the newer one
      const base = Number(req.headers.get("if-match"));
      if (!Number.isFinite(base) || base !== rev) return json({ error: "conflict", rev }, 409);

      let doc;
      try { doc = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      if (!doc || typeof doc !== "object") return json({ error: "bad doc" }, 400);

      const next = rev + 1;
      await env.BIKES.put("doc", JSON.stringify({ rev: next, doc }));
      return json({ rev: next });
    }

    return json({ error: "method not allowed" }, 405);
  },
};
