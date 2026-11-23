// Supabase Edge Function: football
// Data comes from football-data.org (free plan). Crests come from API-Football (optional).
// The website only ever talks to THIS function. The function answers from a saved copy (the cache) in your database
// and refreshes that copy slowly and politely, so you never go over football-data.org's 10 requests a minute.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import * as L from './lib.ts';

declare const Deno: any;
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const FD_TOKEN = Deno.env.get('FOOTBALL_DATA_TOKEN') || '';
const AF_KEY = Deno.env.get('API_FOOTBALL_KEY') || '';                 // optional: only used to find crests
const AF_SEASON = Deno.env.get('API_FOOTBALL_CREST_SEASON') || '2023';   // a season your free API-Football plan can read
const AF_DAILY_CAP = Number(Deno.env.get('API_FOOTBALL_DAILY_CAP') || 60); // never use more than this many crest lookups a day
const GAP_MS = 6500;                                                     // 6.5 s between football-data.org calls = about 9 a minute

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const send = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/* ---------- small database helpers ---------- */
async function getRow(key: string) {
  const { data } = await sb.from('fd_cache').select('key,payload,fetched_at,meta').eq('key', key).maybeSingle();
  return data ? { payload: data.payload, at: Date.parse(data.fetched_at), meta: data.meta || {} } : null;
}
async function putRow(key: string, payload: unknown, meta: unknown) {
  const { error } = await sb.from('fd_cache').upsert({ key, payload, meta, fetched_at: new Date().toISOString() });
  if (error) throw new Error('Could not save to the database: ' + error.message);
}
const tryLock = async (name: string, seconds: number) => !!(await sb.rpc('fd_try_lock', { p_name: name, p_seconds: seconds })).data;
const unlock = (name: string) => sb.rpc('fd_unlock', { p_name: name });
async function setError(key: string, message: string) { await sb.from('fd_cache').upsert({ key: 'e:' + key, payload: { message }, meta: {}, fetched_at: new Date().toISOString() }); }
async function clearError(key: string) { await sb.from('fd_cache').delete().eq('key', 'e:' + key); }

/* ---------- talking to football-data.org (one call at a time, 6.5 s apart, across ALL running copies of this function) ---------- */
async function fdGet(path: string) {
  if (!FD_TOKEN) throw new Error('The football-data.org token is missing. Add the secret FOOTBALL_DATA_TOKEN.');
  const { data: wait } = await sb.rpc('fd_reserve_slot', { p_gap_ms: GAP_MS });
  if (wait > 110000) throw new Error('The football-data.org queue is full. Try again in a minute.');
  if (wait > 0) await sleep(wait);
  await sb.rpc('fd_count', { p_provider: 'fd' });
  const r = await fetch('https://api.football-data.org/v4' + path, { headers: { 'X-Auth-Token': FD_TOKEN } });
  const j = await r.json().catch(() => null);
  if (r.status === 429) throw new Error('football-data.org says: too many requests. Waiting a little.');
  if (!r.ok) throw new Error((j && (j.message || j.error)) || 'football-data.org answered with error ' + r.status);
  return j;
}

/* ---------- teams and crests ---------- */
async function rememberTeams(teams: any[], comp: L.Comp) {
  if (!teams.length) return;
  await sb.from('fd_team_map').upsert(teams.map((t) => ({ fd_id: t.id, name: t.name, fd_crest: t.crest || null, af_league: comp.af })), { onConflict: 'fd_id', ignoreDuplicates: true });
}
async function crestsFor(teams: any[]) {
  const ids = teams.map((t) => t.id); if (!ids.length) return {};
  const { data } = await sb.from('fd_team_map').select('fd_id,af_id,fd_crest').in('fd_id', ids);
  const map: Record<number, any> = {}; (data || []).forEach((r: any) => (map[r.fd_id] = r));
  return L.crestMap(teams, map);
}
async function afGet(path: string) {
  const { data: n } = await sb.rpc('fd_count', { p_provider: 'af' });
  if (n > AF_DAILY_CAP) throw new Error('crest lookup limit for today reached');
  const r = await fetch('https://v3.football.api-sports.io' + path, { headers: { 'x-apisports-key': AF_KEY } });
  const j = await r.json().catch(() => null);
  const er = j && j.errors; if (er && (Array.isArray(er) ? er.length : Object.keys(er).length)) throw new Error(JSON.stringify(er));
  return (j && j.response) || [];
}
// Find the API-Football id of every team once, so the site keeps showing the crests it always showed.
async function mapCrests() {
  if (!AF_KEY) return;
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  const { data: todo } = await sb.from('fd_team_map').select('fd_id,name,af_league,tried_at').is('af_id', null).or(`tried_at.is.null,tried_at.lt.${dayAgo}`).limit(120);
  if (!todo || !todo.length) return;
  const found: any[] = [];
  const leagues = [...new Set(todo.map((t: any) => t.af_league).filter((x: number) => x && x !== 2))];
  for (const lg of leagues) {
    try {
      const list = (await afGet(`/teams?league=${lg}&season=${AF_SEASON}`)).map((x: any) => x.team);
      for (const t of todo.filter((x: any) => x.af_league === lg)) { const id = L.matchTeam(list, t.name); if (id) { found.push({ fd_id: t.fd_id, af_id: id }); t.done = 1; } }
    } catch (e) { console.log('crest list failed for league', lg, String(e)); break; }
  }
  for (const t of todo.filter((x: any) => !x.done)) {
    try {
      const q = L.normKey(t.name).replace(/[^a-z0-9 ]/g, '');
      if (q.length < 3) continue;
      const list = (await afGet(`/teams?search=${encodeURIComponent(q)}`)).map((x: any) => x.team);
      const id = L.matchTeam(list, t.name); if (id) { found.push({ fd_id: t.fd_id, af_id: id }); }
    } catch (e) { console.log('crest search stopped:', String(e)); break; }
  }
  const now = new Date().toISOString();
  for (const f of found) await sb.from('fd_team_map').update({ af_id: f.af_id, matched_at: now }).eq('fd_id', f.fd_id);
  const foundIds = new Set(found.map((f) => f.fd_id));
  const miss = todo.filter((t: any) => !foundIds.has(t.fd_id)).map((t: any) => t.fd_id);
  if (miss.length) await sb.from('fd_team_map').update({ tried_at: now }).in('fd_id', miss);
}

/* ---------- refreshing one piece of data ---------- */
async function refresh(kind: 'm' | 's' | 'p', comp: L.Comp, season: number, reason = '') {
  const key = L.keyOf(kind, comp.af, season);
  try {
    if (kind === 'm') {
      const j = await fdGet(`/competitions/${comp.code}/matches?season=${season}`);
      const b = L.buildFixtures(j.matches || [], comp);
      await rememberTeams(b.teams, comp);
      await putRow(key, { fx: b.fx, teams: b.teams, lg: { id: comp.af, name: comp.name, country: comp.country, season } }, { fin: b.fin, sched: b.sched });
    } else {
      const m = await getRow(L.keyOf('m', comp.af, season));
      const finSeen = m ? m.meta.fin : 0, now = Date.now();
      const recheck = reason === 'new result' ? now + L.T.recheck : 0;
      if (kind === 's') {
        const j = await fdGet(`/competitions/${comp.code}/standings?season=${season}`);
        const b = L.buildStandings(j);
        await rememberTeams(b.teams, comp);
        await putRow(key, { rows: b.rows, teams: b.teams }, { finSeen, recheck });
      } else {
        const j = await fdGet(`/competitions/${comp.code}/scorers?season=${season}&limit=50`);
        await putRow(key, { sc: L.buildScorers(j) }, { finSeen, recheck });
      }
    }
    await clearError(key);
  } catch (e) {
    await setError(key, String((e as Error).message || e));
    throw e;
  }
}
// used when somebody asks for something that is not saved yet
async function ensure(kind: 'm' | 's' | 'p', comp: L.Comp, season: number) {
  const key = L.keyOf(kind, comp.af, season);
  const hit = await getRow(key); if (hit) return hit;
  const er = await getRow('e:' + key);
  if (er && Date.now() - er.at < 30 * L.MIN) throw new Error(er.payload.message);
  for (let i = 0; i < 55; i++) {
    if (await tryLock('f:' + key, 100)) {
      try { if (!(await getRow(key))) await refresh(kind, comp, season, 'first load'); } finally { await unlock('f:' + key); }
      const row = await getRow(key); if (row) return row;
      throw new Error('Could not load this data.');
    }
    await sleep(2000);
    const row = await getRow(key); if (row) return row;
  }
  throw new Error('The data is still loading. Try again in a minute.');
}

/* ---------- the scheduler: decides what is due and does at most a few calls per run ---------- */
async function loadState() {
  const { data } = await sb.from('fd_cache').select('key,fetched_at,meta');
  const st: Record<string, L.CacheInfo> = {};
  (data || []).forEach((r: any) => (st[r.key] = { at: Date.parse(r.fetched_at), meta: r.meta || {} }));
  return st;
}
async function tick(maxCalls = 8, maxMs = 100000) {
  if (!(await tryLock('tick', 110))) return { skipped: 'already running' };
  const started = Date.now(); let calls = 0; const done: string[] = [];
  try {
    await sb.from('fd_gate').update({ last_tick: new Date().toISOString() }).eq('id', 1);
    const tasks = L.dueTasks(Date.now(), await loadState());
    for (const t of tasks) {
      if (calls >= maxCalls || Date.now() - started > maxMs) break;
      if (!(await tryLock('f:' + t.key, 100))) continue;          // someone else is already fetching this one
      try {
        const cur = await getRow(t.key);
        if (cur && Date.now() - cur.at < 45000) continue;         // it was refreshed a moment ago
        await refresh(t.kind, t.comp, L.seasonOf(t.comp), t.reason); calls++; done.push(`${t.kind}:${t.comp.code} (${t.reason})`);
      } catch (e) { calls++; console.log('refresh failed', t.key, String(e)); } finally { await unlock('f:' + t.key); }
    }
    if (Date.now() - started < maxMs - 20000) { try { await mapCrests(); } catch (e) { console.log('crest mapping', String(e)); } }
  } finally { await unlock('tick'); }
  return { calls, done };
}
async function maybeTick() {
  const { data } = await sb.from('fd_gate').select('last_tick').eq('id', 1).maybeSingle();
  const last = data && data.last_tick ? Date.parse(data.last_tick) : 0;
  if (Date.now() - last > 45000) EdgeRuntime.waitUntil(tick().catch((e) => console.log('tick failed', String(e))));
}

/* ---------- what the website asks for ---------- */
const need = (id: number) => { const c = L.compByAf(id); if (!c) throw new Error('This competition is not on the football-data.org free plan.'); return c; };
async function fixtures(u: URL) {
  const comp = need(Number(u.searchParams.get('league'))), season = Number(u.searchParams.get('season')) || L.seasonOf(comp);
  if (u.searchParams.get('ids')) return { response: { fx: [] } };
  const row = await ensure('m', comp, season);
  const fx = L.toSiteFixtures(row.payload.fx, u.searchParams.get('from') || '', u.searchParams.get('to') || '');
  return { response: { fx, lg: row.payload.lg, cr: await crestsFor(row.payload.teams) }, asOf: row.at };
}
async function standings(u: URL) {
  const comp = need(Number(u.searchParams.get('league'))), season = Number(u.searchParams.get('season')) || L.seasonOf(comp);
  const row = await ensure('s', comp, season);
  return { response: { rows: row.payload.rows, cr: await crestsFor(row.payload.teams) }, asOf: row.at };
}
async function players(u: URL, assists: boolean) {
  const comp = need(Number(u.searchParams.get('league'))), season = Number(u.searchParams.get('season')) || L.seasonOf(comp);
  const row = await ensure('p', comp, season);
  return { response: assists ? L.assistsOf(row.payload.sc) : row.payload.sc, asOf: row.at };
}
async function version() {   // tiny answer so every browser can ask "has anything changed?" once a minute
  const { data } = await sb.from('fd_cache').select('key,fetched_at');
  const out: any = { m: {}, s: {}, p: {} };
  for (const c of L.COMPS) for (const k of ['m', 's', 'p'] as const) {
    const r = (data || []).find((x: any) => x.key === L.keyOf(k, c.af, L.seasonOf(c)));
    if (r) out[k][c.af] = Date.parse(r.fetched_at);
  }
  return { response: out };
}
async function status() {
  const { data: use } = await sb.from('fd_usage').select('provider,calls').eq('day', new Date().toISOString().slice(0, 10));
  const get = (p: string) => ((use || []).find((x: any) => x.provider === p) || {}).calls || 0;
  const { count: teams } = await sb.from('fd_team_map').select('fd_id', { count: 'exact', head: true });
  const { count: mapped } = await sb.from('fd_team_map').select('fd_id', { count: 'exact', head: true }).not('af_id', 'is', null);
  const { data: errs } = await sb.from('fd_cache').select('key,payload').like('key', 'e:%');
  const { data: gate } = await sb.from('fd_gate').select('last_tick').eq('id', 1).maybeSingle();
  return { response: { plan: 'football-data.org (free)', used: get('fd'), limit: null, fdToday: get('fd'), afToday: get('af'), perMinute: 10, teams: teams || 0, mapped: mapped || 0,
    tickAt: gate && gate.last_tick ? Date.parse(gate.last_tick) : 0, errors: (errs || []).slice(0, 5).map((e: any) => e.key.slice(2) + ': ' + (e.payload && e.payload.message)), crestKey: !!AF_KEY } };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const u = new URL(req.url);
    let path = u.searchParams.get('path') || '';
    if (!path && req.method === 'POST') { try { path = (await req.json()).path || ''; } catch (_) { /* no body */ } }
    if (path !== 'tick') await maybeTick();
    switch (path) {
      case 'fixtures': return send(await fixtures(u));
      case 'standings': return send(await standings(u));
      case 'players/topscorers': return send(await players(u, false));
      case 'players/topassists': return send(await players(u, true));
      case 'version': return send(await version());
      case 'status': return send(await status());
      case 'tick': return send({ response: await tick() });
      case 'live': return send({ response: { fx: [] } });   // not used any more: match status now comes from the saved copy
      case 'teams': case 'leagues': return send({ response: [] });
      default: return send({ error: 'Unknown request.' }, 404);
    }
  } catch (e) {
    return send({ error: String((e as Error).message || e) }, 502);
  }
});
