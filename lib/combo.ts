import type { MatchModel } from "./model";

export type Leg =
  | { market: "1x2"; pick: "home" | "draw" | "away" }
  | { market: "double_chance"; pick: "home_or_draw" | "home_or_away" | "draw_or_away" }
  | { market: "dnb"; pick: "home" | "away" }
  | { market: "total"; pick: "over" | "under"; line: number }
  | { market: "team_total"; team: "home" | "away"; pick: "over" | "under"; line: number }
  | { market: "btts"; pick: "yes" | "no" }
  | { market: "ah"; pick: "home" | "away"; line: number } // line applies to the picked side
  | { market: "clean_sheet"; team: "home" | "away"; pick: "yes" | "no" }
  | { market: "win_to_nil"; team: "home" | "away"; pick: "yes" | "no" };

export type OddsLeg = { leg: Leg; price: number };

/** Markets the goals model can't price (corners, cards): probability comes from
 *  the market itself with the bookmaker margin removed — no model edge claimed. */
export type ExtraLeg = { group: string; label: string; price: number; fairP: number };

export type EventOdds = {
  id: number;
  home: string;
  away: string;
  date?: string;
  live?: boolean;
  legs: OddsLeg[];
  extras?: ExtraLeg[];
};

export function kelly(p: number, odds: number): number {
  const b = odds - 1;
  return b > 0 ? Math.max(0, (p * odds - 1) / b) : 0;
}

/** Kelly with push mass: w/l are win/loss probabilities, pushes return the stake. */
export function kellyPush(w: number, l: number, odds: number): number {
  const b = odds - 1;
  return b > 0 && w + l > 0 ? Math.max(0, (w * b - l) / (b * (w + l))) : 0;
}

// ---- settlement ----

type Settled = "win" | "halfWin" | "push" | "halfLoss" | "loss";

// .25/.75 lines split the stake across the adjacent half lines
const isQuarterLine = (line: number) => (line * 2) % 1 !== 0;

function half(lo: Settled, hi: Settled): Settled {
  const s = (o: Settled) => (o === "win" ? 1 : o === "push" ? 0 : -1);
  const t = s(lo) + s(hi);
  return t === 2 ? "win" : t === 1 ? "halfWin" : t === 0 ? "push" : t === -1 ? "halfLoss" : "loss";
}

function settleOU(v: number, line: number, over: boolean): Settled {
  if (isQuarterLine(line)) return half(settleOU(v, line - 0.25, over), settleOU(v, line + 0.25, over));
  if (v === line) return "push";
  return (over ? v > line : v < line) ? "win" : "loss";
}

function settleHandicap(margin: number, line: number): Settled {
  if (isQuarterLine(line)) return half(settleHandicap(margin, line - 0.25), settleHandicap(margin, line + 0.25));
  const x = margin + line;
  if (x === 0) return "push";
  return x > 0 ? "win" : "loss";
}

function settle(leg: Leg, h: number, a: number): Settled {
  switch (leg.market) {
    case "1x2":
      return (leg.pick === "home" ? h > a : leg.pick === "away" ? a > h : h === a) ? "win" : "loss";
    case "double_chance":
      return (leg.pick === "home_or_draw" ? h >= a : leg.pick === "draw_or_away" ? a >= h : h !== a)
        ? "win"
        : "loss";
    case "dnb":
      if (h === a) return "push";
      return (leg.pick === "home" ? h > a : a > h) ? "win" : "loss";
    case "btts":
      return (leg.pick === "yes" ? h >= 1 && a >= 1 : h === 0 || a === 0) ? "win" : "loss";
    case "total":
      return settleOU(h + a, leg.line, leg.pick === "over");
    case "team_total":
      return settleOU(leg.team === "home" ? h : a, leg.line, leg.pick === "over");
    case "ah":
      return settleHandicap(leg.pick === "home" ? h - a : a - h, leg.line);
    case "clean_sheet": {
      const conceded = leg.team === "home" ? a : h;
      return (leg.pick === "yes" ? conceded === 0 : conceded > 0) ? "win" : "loss";
    }
    case "win_to_nil": {
      const wtn = leg.team === "home" ? h > a && a === 0 : a > h && h === 0;
      return (leg.pick === "yes" ? wtn : !wtn) ? "win" : "loss";
    }
  }
}

export type LegEval = {
  w: number; // win probability (half-wins count 0.5)
  l: number; // loss probability (half-losses count 0.5)
  push: number;
  ev: number; // exact expected value per unit stake, pushes included
  binary: boolean; // true when the leg can only win or lose (safe for combos)
};

export function evalLeg(grid: number[][], leg: Leg, price: number): LegEval {
  let w = 0, l = 0, push = 0, ret = 0, binary = true;
  for (let h = 0; h < grid.length; h++)
    for (let a = 0; a < grid[h].length; a++) {
      const p = grid[h][a];
      switch (settle(leg, h, a)) {
        case "win": ret += p * price; w += p; break;
        case "halfWin": ret += (p * (price + 1)) / 2; w += p / 2; push += p / 2; binary = false; break;
        case "push": ret += p; push += p; binary = false; break;
        case "halfLoss": ret += p / 2; l += p / 2; push += p / 2; binary = false; break;
        case "loss": l += p; break;
      }
    }
  return { w, l, push, ev: ret - 1, binary };
}

/** Exact joint probability of all legs winning, from the score grid — correlation included. */
export function jointProb(grid: number[][], legs: Leg[]): number {
  let p = 0;
  for (let h = 0; h < grid.length; h++)
    for (let a = 0; a < grid[h].length; a++)
      if (legs.every((l) => settle(l, h, a) === "win")) p += grid[h][a];
  return p;
}

const fmtLine = (line: number) => (line > 0 ? `+${line}` : `${line}`);

export function legLabel(leg: Leg, home: string, away: string): string {
  switch (leg.market) {
    case "1x2":
      return leg.pick === "home" ? `${home} to win` : leg.pick === "away" ? `${away} to win` : "Draw";
    case "double_chance":
      return leg.pick === "home_or_draw"
        ? `${home} or draw`
        : leg.pick === "draw_or_away"
          ? `${away} or draw`
          : `${home} or ${away}`;
    case "dnb":
      return `${leg.pick === "home" ? home : away} (draw no bet)`;
    case "total":
      return `${leg.pick === "over" ? "Over" : "Under"} ${leg.line} goals`;
    case "team_total":
      return `${leg.team === "home" ? home : away} ${leg.pick} ${leg.line} goals`;
    case "btts":
      return `Both teams to score: ${leg.pick}`;
    case "ah":
      return `${leg.pick === "home" ? home : away} ${fmtLine(leg.line)} (Asian)`;
    case "clean_sheet":
      return `${leg.team === "home" ? home : away} clean sheet: ${leg.pick}`;
    case "win_to_nil":
      return `${leg.team === "home" ? home : away} to win to nil${leg.pick === "no" ? ": no" : ""}`;
  }
}

function combosOf(n: number, k: number): number[][] {
  const res: number[][] = [];
  const cur: number[] = [];
  const rec = (start: number) => {
    if (cur.length === k) {
      res.push([...cur]);
      return;
    }
    for (let i = start; i <= n - (k - cur.length); i++) {
      cur.push(i);
      rec(i + 1);
      cur.pop();
    }
  };
  rec(0);
  return res;
}

export type BuilderPick = {
  match: string;
  date?: string;
  legs: { label: string; odds: number; modelProb: number }[];
  combinedOdds: number; // product of single prices — a real bet-builder quote may differ
  modelProb: number; // exact joint from the score grid
  fairOdds: number;
  correlation: number; // joint / product of marginals; >1 means legs help each other
  ev: number;
  kellyQuarter: number;
};

export function buildBetBuilders(
  model: MatchModel,
  events: EventOdds[],
  opts: { minEdge?: number; maxLegs?: number; perMatch?: number; cap?: number } = {}
): BuilderPick[] {
  const { minEdge = 0.05, maxLegs = 3, perMatch = 3, cap = 24 } = opts;
  const all: BuilderPick[] = [];
  for (const e of events) {
    const grid = model.scoreGrid(e.home, e.away, true);
    // combos need win-or-lose legs only: pushes would void a leg, not the ticket
    type Cand = { label: string; price: number; p: number; mkey: string; leg?: Leg };
    const gridCands: Cand[] = e.legs
      .map(({ leg, price }) => ({ leg, price, ...evalLeg(grid, leg, price) }))
      .filter((l) => l.binary && l.w >= 0.15 && l.w <= 0.92)
      .map((l) => ({
        label: legLabel(l.leg, e.home, e.away),
        price: l.price,
        p: l.w,
        mkey: l.leg.market,
        leg: l.leg,
      }));
    // corners/cards: market-fair probability, independent of the score grid
    const extraCands: Cand[] = (e.extras ?? [])
      .filter((x) => x.fairP >= 0.15 && x.fairP <= 0.92)
      .map((x) => ({ label: x.label, price: x.price, p: x.fairP, mkey: x.group }));
    const cands = [...gridCands, ...extraCands]
      .sort((x, y) => y.p * y.price - x.p * x.price)
      .slice(0, 16);
    const matchPicks: BuilderPick[] = [];
    for (let k = 2; k <= maxLegs; k++)
      for (const idxs of combosOf(cands.length, k)) {
        const legs = idxs.map((i) => cands[i]);
        if (new Set(legs.map((l) => l.mkey)).size < legs.length) continue;
        const gl = legs.filter((l) => l.leg).map((l) => l.leg!);
        const gridJoint = gl.length ? jointProb(grid, gl) : 1;
        const joint = legs.filter((l) => !l.leg).reduce((x, l) => x * l.p, gridJoint);
        if (joint < 0.03) continue;
        // every grid leg must constrain the combo given the others — a (nearly)
        // implied leg inflates the price product with edge no bookmaker would quote
        let redundant = false;
        for (let i = 0; i < gl.length && !redundant; i++) {
          const rest = gl.filter((_, j) => j !== i);
          if (gridJoint > 0.98 * jointProb(grid, rest)) redundant = true;
        }
        if (redundant) continue;
        const combinedOdds = legs.reduce((x, l) => x * l.price, 1);
        const naiveProb = legs.reduce((x, l) => x * l.p, 1);
        const edge = joint * combinedOdds - 1;
        if (edge < minEdge) continue;
        matchPicks.push({
          match: `${e.home} vs ${e.away}`,
          date: e.date,
          legs: legs.map((l) => ({ label: l.label, odds: l.price, modelProb: l.p })),
          combinedOdds,
          modelProb: joint,
          fairOdds: 1 / joint,
          correlation: joint / naiveProb,
          ev: edge,
          kellyQuarter: kelly(joint, combinedOdds) / 4,
        });
      }
    matchPicks.sort((x, y) => y.ev - x.ev);
    all.push(...matchPicks.slice(0, perMatch));
  }
  return all.sort((x, y) => y.ev - x.ev).slice(0, cap);
}

export type ParlayPick = {
  legs: { match: string; label: string; odds: number; modelProb: number; date?: string }[];
  combinedOdds: number;
  modelProb: number;
  impliedProb: number;
  ev: number;
  kellyQuarter: number;
};

/**
 * Lottery tickets that always reach targetOdds when the board allows it at all.
 * Each slot computes the odds it still NEEDS to hit the target with the matches
 * left, then takes the smartest leg (best log(p)/log(odds)) that clears the bar —
 * going as longshot as necessary: draws, big handicaps, underdog wins.
 */
export function buildYoloParlays(
  model: MatchModel,
  events: EventOdds[],
  opts: { targetOdds?: number; maxLegs?: number; cap?: number } = {}
): ParlayPick[] {
  const { targetOdds = 1000, maxLegs = 16, cap = 6 } = opts;

  type C = { match: string; date?: string; label: string; odds: number; p: number; eff: number };
  // every binary leg per fixture — slot pressure decides how longshot to go
  const byMatch = new Map<string, C[]>();
  for (const e of events) {
    const match = `${e.home} vs ${e.away}`;
    const grid = model.scoreGrid(e.home, e.away, true);
    const list: C[] = byMatch.get(match) ?? [];
    for (const { leg, price } of e.legs) {
      const ev = evalLeg(grid, leg, price);
      if (!ev.binary || ev.w <= 0 || ev.w >= 0.97 || price < 1.2) continue;
      list.push({
        match,
        date: e.date,
        label: legLabel(leg, e.home, e.away),
        odds: price,
        p: ev.w,
        eff: Math.log(ev.w) / Math.log(price), // -1 is a fair price; higher is smarter
      });
    }
    if (list.length) byMatch.set(match, list);
  }

  const out: ParlayPick[] = [];
  const usedGlobal = new Set<string>(); // disjoint tickets across the board
  while (out.length < cap) {
    const legs: C[] = [];
    const usedLocal = new Set<string>();
    let odds = 1;
    while (odds < targetOdds && legs.length < maxLegs) {
      const remaining = [...byMatch.keys()].filter((m) => !usedGlobal.has(m) && !usedLocal.has(m));
      if (!remaining.length) break;
      const slots = Math.min(maxLegs - legs.length, remaining.length);
      // average odds each remaining slot must carry to still reach the target
      const need = Math.pow(targetOdds / odds, 1 / slots) * 0.92;
      let best: C | null = null; // smartest leg long enough for the slot
      let longest: C | null = null; // fallback when nothing clears the bar
      for (const m of remaining)
        for (const c of byMatch.get(m)!) {
          if (c.odds >= need && (!best || c.eff > best.eff)) best = c;
          if (!longest || c.odds > longest.odds) longest = c;
        }
      const pick = best ?? longest;
      if (!pick) break;
      legs.push(pick);
      usedLocal.add(pick.match);
      odds *= pick.odds;
    }
    if (odds < targetOdds) break; // the board genuinely can't reach the target
    for (const l of legs) usedGlobal.add(l.match);
    const p = legs.reduce((x, l) => x * l.p, 1);
    out.push({
      legs: legs.map((l) => ({ match: l.match, label: l.label, odds: l.odds, modelProb: l.p, date: l.date })),
      combinedOdds: odds,
      modelProb: p,
      impliedProb: 1 / odds,
      ev: p * odds - 1,
      kellyQuarter: kelly(p, odds) / 4,
    });
  }
  return out.sort((x, y) => y.modelProb - x.modelProb);
}

export function buildParlays(
  model: MatchModel,
  events: EventOdds[],
  opts: {
    minLegEdge?: number;
    minLegProb?: number;
    maxLegs?: number;
    poolSize?: number;
    cap?: number;
  } = {}
): ParlayPick[] {
  const { minLegEdge = 0.02, minLegProb = 0.3, maxLegs = 3, poolSize = 8, cap = 20 } = opts;
  // best value leg per match — one leg per fixture keeps legs independent and
  // placeable (bookmakers reject two outcomes from the same match in a parlay)
  type PoolLeg = { match: string; date?: string; label: string; odds: number; p: number; edge: number };
  const byMatch = new Map<string, PoolLeg>();
  for (const e of events) {
    const match = `${e.home} vs ${e.away}`;
    const grid = model.scoreGrid(e.home, e.away, true);
    let best: PoolLeg | null = null;
    for (const { leg, price } of e.legs) {
      const ev = evalLeg(grid, leg, price);
      if (!ev.binary || ev.w < minLegProb) continue;
      const edge = ev.w * price - 1;
      if (edge >= minLegEdge && (!best || edge > best.edge))
        best = { match, date: e.date, label: legLabel(leg, e.home, e.away), odds: price, p: ev.w, edge };
    }
    const prev = byMatch.get(match);
    if (best && (!prev || best.edge > prev.edge)) byMatch.set(match, best);
  }
  const pool = [...byMatch.values()].sort((x, y) => y.edge - x.edge);
  const top = pool.slice(0, poolSize);
  const out: ParlayPick[] = [];
  for (let k = 2; k <= Math.min(maxLegs, top.length); k++)
    for (const idxs of combosOf(top.length, k)) {
      const legs = idxs.map((i) => top[i]);
      const combinedOdds = legs.reduce((x, l) => x * l.odds, 1);
      const p = legs.reduce((x, l) => x * l.p, 1);
      out.push({
        legs: legs.map((l) => ({
          match: l.match,
          label: l.label,
          odds: l.odds,
          modelProb: l.p,
          date: l.date,
        })),
        combinedOdds,
        modelProb: p,
        impliedProb: 1 / combinedOdds,
        ev: p * combinedOdds - 1,
        kellyQuarter: kelly(p, combinedOdds) / 4,
      });
    }
  return out.sort((x, y) => y.ev - x.ev).slice(0, cap);
}
