// Supabase Edge Function: football
// The app calls  GET {SUPABASE_URL}/functions/v1/football?path=teams&search=Everton
// This forwards it to API-Football with your secret key (kept on the server) and caches the answer.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*", // after launch you can replace * with your website address
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
// Only these API-Football endpoints can be used through this proxy, and how long each answer is kept (seconds).
const TTL: Record<string, number> = {
  teams: 7 * 86400, leagues: 7 * 86400, standings: 1800, fixtures: 600,
  "fixtures/headtohead": 86400, players: 21600, injuries: 3600,
};
const json = (b: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json", ...extra } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ error: "GET only" }, 405);

  const url = new URL(req.url);
  const path = url.searchParams.get("path") ?? "";
  if (!(path in TTL)) return json({ error: "path not allowed" }, 400);

  const params = new URLSearchParams(url.searchParams);
  params.delete("path");
  params.sort();
  const key = `${path}?${params}`;

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const { data } = await sb.from("api_cache").select("body,expires_at").eq("key", key).maybeSingle();
    if (data && new Date(data.expires_at) > new Date()) return json(data.body, 200, { "x-cache": "HIT" });
  } catch (_) { /* cache problems must never break the app */ }

  const apiKey = Deno.env.get("APIFOOTBALL_KEY");
  if (!apiKey) return json({ error: "APIFOOTBALL_KEY secret is not set" }, 500);

  const r = await fetch(`https://v3.football.api-sports.io/${path}?${params}`, { headers: { "x-apisports-key": apiKey } });
  const body = await r.json().catch(() => ({}));
  const errs = body?.errors;
  const hasErr = Array.isArray(errs) ? errs.length > 0 : errs && Object.keys(errs).length > 0;

  if (r.ok && !hasErr) {
    try {
      await sb.from("api_cache").upsert({ key, body, expires_at: new Date(Date.now() + TTL[path] * 1000).toISOString() });
    } catch (_) { /* ignore */ }
  }
  // API-Football reports plan/quota problems inside "errors" with status 200; pass it through so you can see it.
  return json(body, r.ok ? 200 : r.status, { "x-cache": "MISS" });
});
