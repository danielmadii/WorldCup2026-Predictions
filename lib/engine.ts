import { loadMatches, type Match } from "./data";
import { MatchModel } from "./model";
import { evalLeg, legLabel, kellyPush, type Leg, type OddsLeg, type EventOdds } from "./combo";

let trained: { at: number; model: MatchModel; matches: Match[] } | null = null;
const TTL_MS = 60 * 60 * 1000;

export async function getModel(force = false) {
  if (!force && trained && Date.now() - trained.at < TTL_MS) return trained;
  const matches = await loadMatches(force);
  const model = new MatchModel(matches);
  trained = { at: Date.now(), model, matches };
  return trained;
}

// ---- Cloudbet ----
const CB = "https://sports-api.cloudbet.com/pub";

// goal-based markets the score grid can price exactly; corners/bookings markets
// exist on Cloudbet but the model has no corners/cards data, so they are excluded.
// Both spellings are requested and parsed — docs show camelCase in query samples
// while the canonical markets list is snake_case.
const MK = {
  matchOdds: ["soccer.match_odds", "soccer.matchOdds"],
  totals: ["soccer.total_goals", "soccer.totalGoals"],
  btts: ["soccer.both_teams_to_score", "soccer.bothTeamsToScore"],
  doubleChance: ["soccer.double_chance", "soccer.doubleChance"],
  dnb: ["soccer.draw_no_bet", "soccer.drawNoBet"],
  teamTotals: ["soccer.team_total_goals", "soccer.teamTotalGoals"],
  ah: ["soccer.asian_handicap", "soccer.asianHandicap"],
};
const MARKETS_QS = Object.values(MK).flat().map((m) => `markets=${m}`).join("&");

async function cb(path: string): Promise<any> {
  const key = process.env.CLOUDBET_API_KEY;
  if (!key) throw new Error("CLOUDBET_API_KEY is not set");
  const r = await fetch(`${CB}${path}`, {
    headers: { "X-API-Key": key, accept: "application/json" },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`Cloudbet ${r.status}: ${await r.text()}`);
  return r.json();
}

const ALIASES: Record<string, string> = {
  USA: "United States",
  "Korea Republic": "South Korea",
  "IR Iran": "Iran",
  "Côte d'Ivoire": "Ivory Coast",
  "Cabo Verde": "Cape Verde",
};
const norm = (n: string) => ALIASES[n] ?? n;

const DC_OUTCOMES: Record<string, "home_or_draw" | "home_or_away" | "draw_or_away"> = {
  home_or_draw: "home_or_draw",
  home_or_away: "home_or_away",
  draw_or_away: "draw_or_away",
  away_or_draw: "draw_or_away",
  "1x": "home_or_draw",
  "12": "home_or_away",
  x2: "draw_or_away",
};

function parseLegs(markets: any): OddsLeg[] {
  const found: OddsLeg[] = [];
  const scan = (keys: string[], toLeg: (outcome: string, params: string) => Leg | null) => {
    for (const key of keys)
      for (const [subKey, sub] of Object.entries<any>(markets?.[key]?.submarkets ?? {}))
        for (const sel of sub.selections ?? []) {
          if (sel.status === "SELECTION_DISABLED" || sel.side === "LAY") continue;
          const price = Number(sel.price);
          const leg = toLeg(String(sel.outcome ?? ""), String(sel.params || subKey || ""));
          if (leg && Number.isFinite(price) && price > 1) found.push({ leg, price });
        }
  };
  // pushes and quarter lines are settled exactly by the combo engine
  const validLine = (line: number) => Number.isFinite(line) && Math.round(line * 4) === line * 4;
  scan(MK.matchOdds, (o) =>
    o === "home" || o === "draw" || o === "away" ? { market: "1x2", pick: o } : null
  );
  scan(MK.totals, (o, params) => {
    const line = Number(new URLSearchParams(params).get("total"));
    if (!validLine(line) || line <= 0) return null;
    return o === "over" || o === "under" ? { market: "total", pick: o, line } : null;
  });
  scan(MK.teamTotals, (o, params) => {
    const sp = new URLSearchParams(params);
    const line = Number(sp.get("total"));
    const team = sp.get("team");
    if (!validLine(line) || line <= 0 || (team !== "home" && team !== "away")) return null;
    return o === "over" || o === "under" ? { market: "team_total", team, pick: o, line } : null;
  });
  scan(MK.btts, (o) =>
    o === "yes" || o === "no" ? { market: "btts", pick: o } : null
  );
  scan(MK.doubleChance, (o) => {
    const pick = DC_OUTCOMES[o];
    return pick ? { market: "double_chance", pick } : null;
  });
  scan(MK.dnb, (o) =>
    o === "home" || o === "away" ? { market: "dnb", pick: o } : null
  );
  scan(MK.ah, (o, params) => {
    const hcp = Number(new URLSearchParams(params).get("handicap"));
    if (!validLine(hcp)) return null;
    // the submarket line is the home handicap; the away side gets its negation
    if (o === "home") return { market: "ah", pick: "home", line: hcp };
    if (o === "away") return { market: "ah", pick: "away", line: -hcp };
    return null;
  });
  // the same selection can appear in several submarkets; keep the best price
  const best = new Map<string, OddsLeg>();
  for (const l of found) {
    const k = JSON.stringify(l.leg);
    const prev = best.get(k);
    if (!prev || l.price > prev.price) best.set(k, l);
  }
  return [...best.values()];
}

let oddsCache: { at: number; events: EventOdds[] } | null = null;
const ODDS_TTL_MS = 20_000; // several endpoints scan per page load; don't hammer Cloudbet

/** Active men's World Cup competitions — skips women's, qualifiers, outrights,
 *  and anything Cloudbet marks inactive (eventCount 0). */
async function worldCupCompetitions(): Promise<{ key: string; eventCount: number }[]> {
  const sport = await cb("/v2/odds/sports/soccer");
  const found: { key: string; eventCount: number }[] = [];
  for (const cat of sport.categories ?? [])
    for (const comp of cat.competitions ?? []) {
      const k = String(comp.key ?? "").toLowerCase();
      if (!k.includes("world-cup")) continue;
      if (/women|qualif|outright|special|u17|u20|u21|u23|futsal|beach|club/.test(k)) continue;
      found.push({ key: comp.key, eventCount: Number(comp.eventCount ?? 0) });
    }
  return found.sort((a, b) => b.eventCount - a.eventCount);
}

/** Bulk ingestion: one request per competition returns all events with markets. */
export async function fetchWorldCupOdds(): Promise<EventOdds[]> {
  if (oddsCache && Date.now() - oddsCache.at < ODDS_TTL_MS) return oddsCache.events;
  const comps = await worldCupCompetitions();
  const active = comps.filter((c) => c.eventCount > 0);
  if (!active.length)
    throw new Error(
      comps.length
        ? `World Cup competitions exist on Cloudbet but none are active right now: ${comps.map((c) => c.key).join(", ")}`
        : "World Cup competition not found on Cloudbet"
    );

  const events: EventOdds[] = [];
  const seen = new Set<number>();
  const seenFixture = new Set<string>();
  for (const c of active) {
    const comp = await cb(`/v2/odds/competitions/${c.key}?${MARKETS_QS}`);
    for (const ev of comp.events ?? []) {
      // pre-match feeds the model; live events are scanned for pricing anomalies only
      if (ev.status !== "TRADING" && ev.status !== "TRADING_LIVE") continue;
      const home = norm(ev.home?.name ?? "");
      const away = norm(ev.away?.name ?? "");
      if (!home || !away) continue;
      // the same fixture can be listed under several competitions with different
      // event ids — a duplicate would let parlays stack two outcomes on one match
      const fixture = `${home}|${away}|${String(ev.cutoffTime ?? "").slice(0, 10)}`;
      if (seen.has(ev.id) || seenFixture.has(fixture)) continue;
      const legs = parseLegs(ev.markets);
      if (!legs.length) continue;
      seen.add(ev.id);
      seenFixture.add(fixture);
      // trust the clock over the status flag: a future kickoff is never "live",
      // and once kickoff passes the pre-match betting window is closed either way
      const cutoff = Date.parse(ev.cutoffTime ?? "");
      const started = Number.isFinite(cutoff)
        ? cutoff <= Date.now()
        : ev.status === "TRADING_LIVE";
      events.push({
        id: ev.id,
        home,
        away,
        date: ev.cutoffTime ?? undefined,
        live: started,
        legs,
      });
    }
  }
  events.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  oddsCache = { at: Date.now(), events };
  return events;
}

/** Raw diagnostics for /api/debug — shows what Cloudbet actually returns. */
export async function debugWorldCup() {
  const comps = await worldCupCompetitions();
  const fetched: any[] = [];
  for (const c of comps.filter((x) => x.eventCount > 0).slice(0, 3)) {
    const comp = await cb(`/v2/odds/competitions/${c.key}?${MARKETS_QS}`);
    const evs: any[] = comp.events ?? [];
    const statuses: Record<string, number> = {};
    for (const ev of evs) statuses[ev.status] = (statuses[ev.status] ?? 0) + 1;
    const sample = evs.find((ev: any) => ev.markets && Object.keys(ev.markets).length) ?? evs[0];
    fetched.push({
      key: c.key,
      eventsReturned: evs.length,
      statuses,
      sampleEvent: sample
        ? {
            id: sample.id,
            name: `${sample.home?.name} vs ${sample.away?.name}`,
            status: sample.status,
            marketKeys: Object.keys(sample.markets ?? {}),
            parsedLegs: parseLegs(sample.markets).length,
          }
        : null,
    });
  }
  return { competitions: comps, fetched, parsedEvents: (await fetchWorldCupOdds()).length };
}

export type ValuePick = {
  match: string;
  date?: string;
  bet: string;
  odds: number;
  modelProb: number;
  impliedProb: number;
  ev: number;
  kellyQuarter: number;
};

export async function findValueBets(minEdge = 0.03, ids?: Set<number>): Promise<ValuePick[]> {
  const [{ model }, events] = await Promise.all([getModel(), fetchWorldCupOdds()]);
  const picks: ValuePick[] = [];
  for (const ev of events) {
    if (ev.live || (ids && !ids.has(ev.id))) continue;
    const grid = model.scoreGrid(ev.home, ev.away, true);
    for (const { leg, price } of ev.legs) {
      const e = evalLeg(grid, leg, price);
      // skip deep longshots — the Poisson tail is the least reliable part of the model
      if (e.ev < minEdge || e.w < 0.05) continue;
      picks.push({
        match: `${ev.home} vs ${ev.away}`,
        date: ev.date,
        bet: legLabel(leg, ev.home, ev.away),
        odds: price,
        modelProb: e.w,
        impliedProb: 1 / price,
        ev: e.ev,
        kellyQuarter: kellyPush(e.w, e.l, price) / 4,
      });
    }
  }
  return picks.sort((a, b) => b.ev - a.ev).slice(0, 50);
}
