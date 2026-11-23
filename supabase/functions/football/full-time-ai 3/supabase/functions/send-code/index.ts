// Supabase Edge Function: send-code
// The app POSTs {to, code, app, expires_minutes}. This emails the 6 digit code through Resend.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*", // after launch replace * with your website address
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const { to, code, app, expires_minutes } = await req.json().catch(() => ({}));
  if (typeof to !== "string" || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(to) || to.length > 200) return json({ error: "bad email" }, 400);
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return json({ error: "bad code" }, 400);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await sb.from("mail_log").select("id", { count: "exact", head: true }).eq("to_email", to.toLowerCase()).gte("created_at", since);
  if ((count ?? 0) >= 5) return json({ error: "too many emails, try later" }, 429);

  const key = Deno.env.get("RESEND_API_KEY"), from = Deno.env.get("MAIL_FROM");
  if (!key || !from) return json({ error: "RESEND_API_KEY / MAIL_FROM not set" }, 500);

  const name = String(app || "Full Time AI").slice(0, 40), mins = Number(expires_minutes) || 5;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from, to: [to], subject: `${name} code: ${code}`,
      html: `<p>Your ${name} code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It works for ${mins} minutes. If you did not ask for it, ignore this email.</p>`,
    }),
  });
  if (!r.ok) return json({ error: "email provider refused", detail: await r.text() }, 502);
  await sb.from("mail_log").insert({ to_email: to.toLowerCase() });
  return json({ ok: true });
});
