import { loadMatches, upcomingWorldCup, type Match } from "./data";
import { MatchModel } from "./model";
import { jointProb, legLabel, kelly, type Leg, type OddsLeg, type EventOdds } from "./combo";

let trained: { at: number; model: MatchModel; matches: Match[] } | null = null;
const TTL_MS = 60 * 60 * 1000;

export async function getModel(force = false) {
  if (!force && trained && Date.now() - trained.at < TTL_MS) return trained;
  const matches = await loadMatches(force);
  const model = new MatchModel(matches);
  trained = { at: Date.now(), model, matches };
  return trained;
}

export { upcomingWorldCup };

// ---- Cloudbet ----
const CB = "https://sports-api.cloudbet.com/pub";

const FEED_MARKETS = [
  "soccer.match_odds",
  "soccer.total_goals",
  "soccer.both_teams_to_score",
  "soccer.double_chance",
];

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
  const scan = (key: string, toLeg: (outcome: string, params: string) => Leg | null) => {
    for (const [subKey, sub] of Object.entries<any>(markets?.[key]?.submarkets ?? {}))
      for (const sel of sub.selections ?? []) {
        if (sel.status === "SELECTION_DISABLED" || sel.side === "LAY") continue;
        const price = Number(sel.price);
        const leg = toLeg(String(sel.outcome ?? ""), String(sel.params || subKey || ""));
        if (leg && Number.isFinite(price) && price > 1) found.push({ leg, price });
      }
  };
  scan("soccer.match_odds", (o) =>
    o === "home" || o === "draw" || o === "away" ? { market: "1x2", pick: o } : null
  );
  scan("soccer.total_goals", (o, params) => {
    const line = Number(new URLSearchParams(params).get("total"));
    // .5 lines only — integer/quarter lines can push, which breaks combo math
    if (!Number.isFinite(line) || line % 1 !== 0.5) return null;
    return o === "over" || o === "under" ? { market: "total", pick: o, line } : null;
  });
  scan("soccer.both_teams_to_score", (o) =>
    o === "yes" || o === "no" ? { market: "btts", pick: o } : null
  );
  scan("soccer.double_chance", (o) => {
    const pick = DC_OUTCOMES[o];
    return pick ? { market: "double_chance", pick } : null;
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

/** Bulk ingestion: one request returns all events with the requested markets. */
export async function fetchWorldCupOdds(): Promise<EventOdds[]> {
  const sport = await cb("/v2/odds/sports/soccer");
  let compKey: string | null = null;
  for (const cat of sport.categories ?? [])
    for (const comp of cat.competitions ?? [])
      if (comp.key.includes("world-cup") && !comp.key.includes("women"))
        compKey = comp.key;
  if (!compKey) throw new Error("World Cup competition not found on Cloudbet");

  const qs = FEED_MARKETS.map((m) => `markets=${m}`).join("&");
  const comp = await cb(`/v2/odds/competitions/${compKey}?${qs}`);
  const events: EventOdds[] = [];
  for (const ev of comp.events ?? []) {
    // TRADING = open pre-match; the model prices pre-match only, skip live/resulted.
    if (ev.status !== "TRADING") continue;
    const home = norm(ev.home?.name ?? "");
    const away = norm(ev.away?.name ?? "");
    if (!home || !away) continue;
    const legs = parseLegs(ev.markets);
    if (legs.length)
      events.push({ id: ev.id, home, away, date: ev.cutoffTime ?? undefined, legs });
  }
  return events;
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

export async function findValueBets(minEdge = 0.03): Promise<ValuePick[]> {
  const [{ model }, events] = await Promise.all([getModel(), fetchWorldCupOdds()]);
  const picks: ValuePick[] = [];
  for (const ev of events) {
    const grid = model.scoreGrid(ev.home, ev.away, true);
    for (const { leg, price } of ev.legs) {
      const p = jointProb(grid, [leg]);
      const edge = p * price - 1;
      if (edge >= minEdge)
        picks.push({
          match: `${ev.home} vs ${ev.away}`,
          date: ev.date,
          bet: legLabel(leg, ev.home, ev.away),
          odds: price,
          modelProb: p,
          impliedProb: 1 / price,
          ev: edge,
          kellyQuarter: kelly(p, price) / 4,
        });
    }
  }
  return picks.sort((a, b) => b.ev - a.ev);
}
