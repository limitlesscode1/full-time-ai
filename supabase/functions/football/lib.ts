// Pure logic for the football function (no network, no database).
// Everything here can be tested on its own with: node --experimental-strip-types test.mjs

export type Comp = { af: number; code: string; name: string; country: string; cal?: boolean };

// The competitions the football-data.org FREE plan gives you, shown with the ids your site already uses (API-Football ids).
export const COMPS: Comp[] = [
  { af: 39, code: 'PL', name: 'Premier League', country: 'England' },
  { af: 40, code: 'ELC', name: 'Championship', country: 'England' },
  { af: 140, code: 'PD', name: 'La Liga', country: 'Spain' },
  { af: 78, code: 'BL1', name: 'Bundesliga', country: 'Germany' },
  { af: 135, code: 'SA', name: 'Serie A', country: 'Italy' },
  { af: 61, code: 'FL1', name: 'Ligue 1', country: 'France' },
  { af: 88, code: 'DED', name: 'Eredivisie', country: 'Netherlands' },
  { af: 94, code: 'PPL', name: 'Primeira Liga', country: 'Portugal' },
  { af: 2, code: 'CL', name: 'UEFA Champions League', country: 'Europe' },
  { af: 71, code: 'BSA', name: 'Brasileirão Série A', country: 'Brazil', cal: true },
];

export const MIN = 60000;
export const T = {
  matchesActive: 2 * MIN,      // active match competitions: check every 2 minutes
  matchesIdle: 120 * MIN,      // nothing on: look every 2 hours
  tableIdle: 180 * MIN,        // tables: at least every 3 hours
  scorersIdle: 360 * MIN,      // top scorers: at least every 6 hours
  afterResult: 2 * MIN,        // a new result appeared: update table/players within ~2 minutes
  recheck: 15 * MIN,           // and once more 15 minutes later (the free plan can be late)
  errorBackoff: 10 * MIN,      // after an error wait 10 minutes before asking again
  playingWindow: 120 * MIN,    // tolerate delayed provider status for up to two hours after kickoff
};

export const compByAf = (id: number) => COMPS.find((c) => c.af === id);

export function seasonOf(c: Comp, now = Date.now()): number {
  const d = new Date(now);
  return c.cal ? d.getUTCFullYear() : d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

/* ---------- names ---------- */
const strip = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
export function normKey(n: string): string {
  return strip(String(n || '')).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter((w) => w && !/^(fc|cf|afc|ac|as|sc|sv|ssc|fk|bk|cd|ud|rcd|us|vfb|vfl|tsg|sk|nk|club|de|the|calcio|\d{2,4})$/.test(w)).join(' ');
}
// football-data.org spellings -> the names your site already uses (add more lines here if a team shows a different name)
const ALIAS: Record<string, string> = {
  'wolverhampton wanderers': 'Wolves', 'wolverhampton': 'Wolves', 'brighton and hove albion': 'Brighton', 'brighton hove': 'Brighton',
  'tottenham hotspur': 'Tottenham', 'newcastle united': 'Newcastle', 'west ham united': 'West Ham', 'leeds united': 'Leeds',
  'bournemouth': 'Bournemouth', 'man united': 'Manchester United', 'man city': 'Manchester City', 'nottingham forest': 'Nottingham Forest',
  'club atletico de madrid': 'Atletico Madrid', 'atletico madrid': 'Atletico Madrid', 'atleti': 'Atletico Madrid', 'athletic club': 'Athletic Club',
  'internazionale milano': 'Inter', 'inter milan': 'Inter', 'internazionale': 'Inter', 'napoli': 'Napoli', 'paris saint germain': 'Paris Saint Germain', 'psg': 'Paris Saint Germain',
  'bayern munchen': 'Bayern Munich', 'bayern': 'Bayern Munich', 'borussia monchengladbach': 'Borussia Monchengladbach', 'monchengladbach': 'Borussia Monchengladbach',
  'bayer 04 leverkusen': 'Bayer Leverkusen', 'leverkusen': 'Bayer Leverkusen', 'rb leipzig': 'RB Leipzig', 'sporting clube de portugal': 'Sporting CP', 'sporting cp': 'Sporting CP',
  'sport lisboa e benfica': 'Benfica', 'benfica': 'Benfica', 'futebol clube do porto': 'FC Porto', 'porto': 'FC Porto',
};
export function cleanName(name?: string, short?: string): string {
  for (const cand of [name, short]) { const a = ALIAS[normKey(cand || '')]; if (a) return a; }
  const base = String(short || name || '').trim();
  return base.replace(/\s+(FC|CF|AFC)$/i, '').replace(/^(FC|AFC|CF)\s+/i, '').trim() || base;
}

/* ---------- fixtures ---------- */
export function roundLabel(m: any, comp: Comp): string {
  const st = m.stage || 'REGULAR_SEASON', md = m.matchday;
  if (comp.af !== 2) return 'Regular Season - ' + (md || 1);
  if (st === 'LEAGUE_STAGE' || st === 'GROUP_STAGE') return (st === 'LEAGUE_STAGE' ? 'League Stage - ' : 'Group Stage - ') + (md || 1);
  const names: Record<string, string> = { PLAYOFFS: 'Play-offs', LAST_16: 'Round of 16', QUARTER_FINALS: 'Quarter-finals', SEMI_FINALS: 'Semi-finals', FINAL: 'Final' };
  return names[st] || String(st).toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
export function statusCode(raw: string, koMs: number, now: number): string {
  if (raw === 'FINISHED' || raw === 'AWARDED') return 'FT';
  if (raw === 'IN_PLAY' || raw === 'PAUSED' || raw === 'LIVE') return 'LIVE';
  if (raw === 'POSTPONED' || raw === 'SUSPENDED' || raw === 'CANCELLED') return 'PST';
  // SCHEDULED / TIMED: the free plan can be late, so a game that has kicked off counts as "playing now"
  if (koMs <= now && now <= koMs + T.playingWindow) return 'LIVE';
  if (koMs < now - T.playingWindow) return 'UNK'; // old kickoff with no confirmed provider status: never call it upcoming
  return 'NS';
}
// cached row: [id, kickoffSeconds, homeId, homeName, awayId, awayName, homeGoals, awayGoals, RAW status, minute, round, leagueId]
export function buildFixtures(matches: any[], comp: Comp) {
  const fx: any[] = [], teams = new Map<number, any>(), sched: any[] = [];
  let fin = 0;
  for (const m of matches || []) {
    if (!m || !m.homeTeam || !m.awayTeam || !m.utcDate) continue;
    const ko = Date.parse(m.utcDate); if (!isFinite(ko)) continue;
    const done = m.status === 'FINISHED' || m.status === 'AWARDED';
    if (done) fin++;
    const ft = (m.score && m.score.fullTime) || {};
    const hn = cleanName(m.homeTeam.name, m.homeTeam.shortName), an = cleanName(m.awayTeam.name, m.awayTeam.shortName);
    teams.set(m.homeTeam.id, { id: m.homeTeam.id, name: hn, crest: m.homeTeam.crest || '' });
    teams.set(m.awayTeam.id, { id: m.awayTeam.id, name: an, crest: m.awayTeam.crest || '' });
    fx.push([m.id, Math.floor(ko / 1000), m.homeTeam.id, hn, m.awayTeam.id, an, ft.home ?? null, ft.away ?? null, m.status || 'SCHEDULED', m.minute ?? null, roundLabel(m, comp), comp.af]);
    sched.push([Math.floor(ko / 1000), done ? 1 : 0]);
  }
  const now = Date.now() / 1000;
  return { fx, teams: [...teams.values()], fin, sched: sched.filter((s) => s[0] > now - 86400 && s[0] < now + 2 * 86400) };
}
// what the website receives: the same arrays as before, with the status turned into the codes the site knows
export function toSiteFixtures(rows: any[], from: string, to: string, now = Date.now()) {
  const out: any[] = [];
  for (const r of rows) {
    const day = new Date(r[1] * 1000).toISOString().slice(0, 10);
    if ((from && day < from) || (to && day > to)) continue;
    const code = statusCode(r[8], r[1] * 1000, now);
    out.push([r[0], r[1], r[2], r[3], r[4], r[5], (code === 'FT' || code === 'LIVE') ? r[6] : null, (code === 'FT' || code === 'LIVE') ? r[7] : null, code, r[9] ?? null, r[10], r[11]]);
  }
  return out;
}

/* ---------- tables and players ---------- */
export function buildStandings(j: any) {
  const all: any[] = (j && j.standings) || [], teams = new Map<number, any>();
  const side = (type: string, grp: any) => {
    const m = new Map<number, number[]>();
    for (const s of all) if (s.type === type && (s.group || null) === (grp || null)) for (const r of s.table || []) m.set(r.team.id, [r.playedGames, r.won, r.draw, r.lost, r.goalsFor, r.goalsAgainst]);
    return m;
  };
  const rows: any[] = [];
  for (const s of all) {
    if (s.type !== 'TOTAL') continue;
    const grp = s.group ? String(s.group).replace(/_/g, ' ').toLowerCase().replace(/(^|\s)\S/g, (c: string) => c.toUpperCase()) : '';
    const h = side('HOME', s.group), a = side('AWAY', s.group);
    for (const r of s.table || []) {
      const nm = cleanName(r.team.name, r.team.shortName);
      teams.set(r.team.id, { id: r.team.id, name: nm, crest: r.team.crest || '' });
      rows.push([r.team.id, nm, r.position, r.playedGames, r.won, r.draw, r.lost, r.goalsFor, r.goalsAgainst, r.points,
        String(r.form || '').replace(/[^WDL]/g, '').slice(-5), grp, '', h.get(r.team.id) || null, a.get(r.team.id) || null]);
    }
  }
  return { rows, teams: [...teams.values()] };
}
// [playerId, name, teamId, teamName, goals, assists, matchesPlayed]
export function buildScorers(j: any) {
  return ((j && j.scorers) || []).map((s: any) => [s.player.id, s.player.name, s.team.id, cleanName(s.team.name, s.team.shortName), s.goals || 0, s.assists || 0, s.playedMatches || 0]);
}
export const assistsOf = (sc: any[]) => sc.filter((x) => x[5] > 0).sort((a, b) => b[5] - a[5] || b[4] - a[4]).slice(0, 30);

/* ---------- crests ---------- */
export const afCrest = (afId: number) => `https://media.api-sports.io/football/teams/${afId}.png`;
export function crestMap(teams: { id: number; name: string; crest: string }[], map: Record<number, { af_id: number | null; fd_crest: string | null }>) {
  const out: Record<string, string> = {};
  // the football-data.org badge belongs to the exact team id, so it is always the right club; the name-matched API-Football id is only a fallback
  for (const t of teams) { const m = map[t.id]; const u = (m && m.fd_crest) || t.crest || (m && m.af_id ? afCrest(m.af_id) : ''); if (u) out[t.name] = u; }
  return out;
}
// find our team in a list of API-Football teams ([{id,name}]). Exact name only: guessing by "contains" picked the wrong clubs and national teams.
export function matchTeam(list: { id: number; name: string }[], name: string): number | null {
  const k = normKey(name); if (!k) return null;
  const c = normKey(cleanName(name));
  const hit = list.find((t) => normKey(t.name) === k) || list.find((t) => normKey(t.name) === c || normKey(cleanName(t.name)) === c);
  return hit ? hit.id : null;
}

/* ---------- the refresh plan ---------- */
export type CacheInfo = { at: number; meta: any };
export type Task = { comp: Comp; kind: 'm' | 's' | 'p'; key: string; prio: number; reason: string; age: number };
export function isActive(sched: any[] | undefined, now: number): boolean {
  const s = now / 1000;
  return (sched || []).some(([ko, done]: number[]) => (done ? s < ko + 150 * 60 : ko <= s + 300 && s <= ko + 270 * 60));
}
export const keyOf = (kind: string, af: number, season: number) => `${kind}:${af}:${season}`;
export function dueTasks(now: number, state: Record<string, CacheInfo>, comps: Comp[] = COMPS): Task[] {
  const tasks: Task[] = [];
  for (const comp of comps) {
    const season = seasonOf(comp, now);
    const mk = keyOf('m', comp.af, season), sk = keyOf('s', comp.af, season), pk = keyOf('p', comp.af, season);
    const m = state[mk], s = state[sk], p = state[pk];
    const blocked = (k: string) => { const e = state['e:' + k]; return !!e && now - e.at < T.errorBackoff; };
    const add = (kind: 'm' | 's' | 'p', key: string, prio: number, reason: string, at: number) => { if (!blocked(key)) tasks.push({ comp, kind, key, prio, reason, age: now - at }); };
    // matches
    if (!m) add('m', mk, 0, 'first load', 0);
    else if (isActive(m.meta && m.meta.sched, now) && now - m.at >= T.matchesActive) add('m', mk, 1, 'a game is on', m.at);
    else if (now - m.at >= T.matchesIdle) add('m', mk, 3, 'regular check', m.at);
    // table and players: when a new finished match appeared, and then once more later
    const fin = m && m.meta ? m.meta.fin : 0;
    for (const [kind, key, x, idle] of [['s', sk, s, T.tableIdle], ['p', pk, p, T.scorersIdle]] as const) {
      if (!x) { add(kind, key, 0, 'first load', 0); continue; }
      if (m && fin !== (x.meta && x.meta.finSeen) && now - x.at >= T.afterResult) add(kind, key, 1, 'new result', x.at);
      else if (x.meta && x.meta.recheck && now >= x.meta.recheck) add(kind, key, 1, 'recheck', x.at);
      else if (now - x.at >= idle) add(kind, key, 3, 'regular check', x.at);
    }
  }
  return tasks.sort((a, b) => a.prio - b.prio || b.age - a.age);
}
