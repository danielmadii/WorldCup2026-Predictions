import { loadMatches, type Match } from "./data";
import { MatchModel } from "./model";
import { evalLeg, legLabel, kellyPush, type Leg, type OddsLeg, type EventOdds, type ExtraLeg } from "./combo";

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
  cleanSheet: ["soccer.team_clean_sheet", "soccer.teamCleanSheet"],
  winToNil: ["soccer.team_win_to_nil", "soccer.teamWinToNil"],
  // corners/cards: the goals model can't price these — they enter bet builders
  // with market-fair probabilities (bookmaker margin removed), no edge claimed
  cornersTotal: ["soccer.total_corners", "soccer.totalCorners"],
  cornerHandicap: ["soccer.corner_handicap", "soccer.cornerHandicap"],
  corner1x2: ["soccer.corner_match_odds", "soccer.cornerMatchOdds"],
  bookings: ["soccer.total_bookings", "soccer.totalBookings"],
  bookingPoints: ["soccer.total_booking_points", "soccer.totalBookingPoints"],
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
  scan(MK.cleanSheet, (o, params) => {
    const team = new URLSearchParams(params).get("team");
    if (team !== "home" && team !== "away") return null;
    return o === "yes" || o === "no" ? { market: "clean_sheet", team, pick: o } : null;
  });
  scan(MK.winToNil, (o, params) => {
    const team = new URLSearchParams(params).get("team");
    if (team !== "home" && team !== "away") return null;
    return o === "yes" || o === "no" ? { market: "win_to_nil", team, pick: o } : null;
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

/** Corners/cards legs for bet builders: probability = the market's own price
 *  with the margin stripped (de-vig), so no fake model edge is ever claimed. */
function parseExtras(markets: any, home: string, away: string): ExtraLeg[] {
  const out: ExtraLeg[] = [];
  type Sel = { outcome: string; price: number; params: string };
  const collect = (keys: string[]): Sel[] => {
    const sels: Sel[] = [];
    for (const key of keys)
      for (const [subKey, sub] of Object.entries<any>(markets?.[key]?.submarkets ?? {}))
        for (const sel of sub.selections ?? []) {
          if (sel.status === "SELECTION_DISABLED" || sel.side === "LAY") continue;
          const price = Number(sel.price);
          if (Number.isFinite(price) && price > 1)
            sels.push({
              outcome: String(sel.outcome ?? ""),
              price,
              params: String(sel.params || subKey || ""),
            });
        }
    return sels;
  };
  const best = (sels: Sel[], keyOf: (s: Sel) => string | null) => {
    const m = new Map<string, Sel>();
    for (const s of sels) {
      const k = keyOf(s);
      if (!k) continue;
      const prev = m.get(k);
      if (!prev || s.price > prev.price) m.set(k, s);
    }
    return m;
  };

  // over/under pairs at .5 lines (win-or-lose only)
  const ou = (keys: string[], group: string, unit: string) => {
    const byKey = best(collect(keys), (s) => {
      const line = Number(new URLSearchParams(s.params).get("total"));
      if (!Number.isFinite(line) || Math.abs(line % 1) !== 0.5) return null;
      return s.outcome === "over" || s.outcome === "under" ? `${s.outcome}|${line}` : null;
    });
    for (const k of byKey.keys()) {
      if (!k.startsWith("over|")) continue;
      const line = k.slice(5);
      const over = byKey.get(k);
      const under = byKey.get(`under|${line}`);
      if (!over || !under) continue;
      const io = 1 / over.price, iu = 1 / under.price;
      out.push({ group, label: `Over ${line} ${unit}`, price: over.price, fairP: io / (io + iu) });
      out.push({ group, label: `Under ${line} ${unit}`, price: under.price, fairP: iu / (io + iu) });
    }
  };
  ou(MK.cornersTotal, "corners_total", "corners");
  ou(MK.bookings, "bookings", "booking pts (1 per yellow, 2 per red)");
  ou(MK.bookingPoints, "booking_points", "booking points (10 yellow / 25 red)");

  // corner handicap: two-way at .5 lines; away side gets the negated line
  {
    const byKey = best(collect(MK.cornerHandicap), (s) => {
      const h = Number(new URLSearchParams(s.params).get("handicap"));
      if (!Number.isFinite(h) || Math.abs(h % 1) !== 0.5) return null;
      return s.outcome === "home" || s.outcome === "away" ? `${s.outcome}|${h}` : null;
    });
    for (const k of byKey.keys()) {
      if (!k.startsWith("home|")) continue;
      const line = Number(k.slice(5));
      const h = byKey.get(k);
      const a = byKey.get(`away|${line}`);
      if (!h || !a) continue;
      const ih = 1 / h.price, ia = 1 / a.price;
      const fmt = (x: number) => (x > 0 ? `+${x}` : `${x}`);
      out.push({ group: "corner_hcp", label: `${home} ${fmt(line)} corners`, price: h.price, fairP: ih / (ih + ia) });
      out.push({ group: "corner_hcp", label: `${away} ${fmt(-line)} corners`, price: a.price, fairP: ia / (ih + ia) });
    }
  }

  // most corners: three-way de-vig
  {
    const byKey = best(collect(MK.corner1x2), (s) =>
      s.outcome === "home" || s.outcome === "draw" || s.outcome === "away" ? s.outcome : null
    );
    const h = byKey.get("home"), d = byKey.get("draw"), a = byKey.get("away");
    if (h && d && a) {
      const s = 1 / h.price + 1 / d.price + 1 / a.price;
      out.push({ group: "corner_1x2", label: `${home} most corners`, price: h.price, fairP: 1 / h.price / s });
      out.push({ group: "corner_1x2", label: "Most corners: draw", price: d.price, fairP: 1 / d.price / s });
      out.push({ group: "corner_1x2", label: `${away} most corners`, price: a.price, fairP: 1 / a.price / s });
    }
  }
  return out;
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

type RawCand = {
  id: number;
  home: string;
  away: string;
  comp: string;
  date?: string;
  cutoffMs: number;
  statusLive: boolean;
  legs: OddsLeg[];
  extras: ExtraLeg[];
};

/** Every valid event from every active competition, grouped by fixture (teams). */
async function collectCandidates() {
  const comps = await worldCupCompetitions();
  const active = comps.filter((c) => c.eventCount > 0);
  if (!active.length)
    throw new Error(
      comps.length
        ? `World Cup competitions exist on Cloudbet but none are active right now: ${comps.map((c) => c.key).join(", ")}`
        : "World Cup competition not found on Cloudbet"
    );
  const byFixture = new Map<string, RawCand[]>();
  const seenIds = new Set<number>();
  for (const c of active) {
    const comp = await cb(`/v2/odds/competitions/${c.key}?${MARKETS_QS}`);
    for (const ev of comp.events ?? []) {
      // pre-match feeds the model; live events are scanned for pricing anomalies only
      if (ev.status !== "TRADING" && ev.status !== "TRADING_LIVE") continue;
      if (seenIds.has(ev.id)) continue;
      const home = norm(ev.home?.name ?? "");
      const away = norm(ev.away?.name ?? "");
      if (!home || !away) continue;
      const legs = parseLegs(ev.markets);
      if (!legs.length) continue;
      seenIds.add(ev.id);
      const cutoffMs = Date.parse(ev.cutoffTime ?? "");
      const cand: RawCand = {
        id: ev.id,
        home,
        away,
        comp: c.key,
        date: ev.cutoffTime ?? undefined,
        cutoffMs: Number.isFinite(cutoffMs) ? cutoffMs : 0,
        statusLive: ev.status === "TRADING_LIVE",
        legs,
        extras: parseExtras(ev.markets, home, away),
      };
      const k = `${home}|${away}`;
      const list = byFixture.get(k) ?? [];
      list.push(cand);
      byFixture.set(k, list);
    }
  }
  return { comps, byFixture };
}

/** The same fixture can be listed several times across competitions, including
 *  ghost entries with placeholder cutoff times. The real listing is the one with
 *  a future kickoff (ghosts carry stale times), then the richest markets, then
 *  the latest cutoff. */
function pickListing(list: RawCand[]): RawCand {
  const now = Date.now();
  return [...list].sort((a, b) => {
    const fa = a.cutoffMs > now ? 1 : 0;
    const fb = b.cutoffMs > now ? 1 : 0;
    if (fa !== fb) return fb - fa;
    if (a.legs.length !== b.legs.length) return b.legs.length - a.legs.length;
    return b.cutoffMs - a.cutoffMs;
  })[0];
}

/** Bulk ingestion: one request per competition returns all events with markets. */
export async function fetchWorldCupOdds(): Promise<EventOdds[]> {
  if (oddsCache && Date.now() - oddsCache.at < ODDS_TTL_MS) return oddsCache.events;
  const { byFixture } = await collectCandidates();
  const events: EventOdds[] = [];
  for (const list of byFixture.values()) {
    const c = pickListing(list);
    // trust the clock over the status flag: a future kickoff is never "live",
    // and once kickoff passes the pre-match betting window is closed either way
    const started = c.cutoffMs ? c.cutoffMs <= Date.now() : c.statusLive;
    events.push({
      id: c.id,
      home: c.home,
      away: c.away,
      date: c.date,
      live: started,
      legs: c.legs,
      extras: c.extras,
    });
  }
  events.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  oddsCache = { at: Date.now(), events };
  return events;
}

/** Raw diagnostics for /api/debug — shows what Cloudbet actually returns,
 *  including every duplicate listing per fixture and which one was chosen. */
export async function debugWorldCup() {
  const { comps, byFixture } = await collectCandidates();
  const fixtures = [...byFixture.entries()].map(([k, list]) => {
    const chosen = pickListing(list);
    return {
      match: k.replace("|", " vs "),
      chosen: { comp: chosen.comp, id: chosen.id, cutoffTime: chosen.date, legs: chosen.legs.length, extras: chosen.extras.length },
      listings: list.map((c) => ({
        comp: c.comp,
        id: c.id,
        cutoffTime: c.date,
        status: c.statusLive ? "TRADING_LIVE" : "TRADING",
        legs: c.legs.length,
      })),
    };
  });
  return { competitions: comps, fixtures, parsedEvents: fixtures.length };
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
