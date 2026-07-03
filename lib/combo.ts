import type { MatchModel } from "./model";

export type Leg =
  | { market: "1x2"; pick: "home" | "draw" | "away" }
  | { market: "double_chance"; pick: "home_or_draw" | "home_or_away" | "draw_or_away" }
  | { market: "dnb"; pick: "home" | "away" }
  | { market: "total"; pick: "over" | "under"; line: number }
  | { market: "team_total"; team: "home" | "away"; pick: "over" | "under"; line: number }
  | { market: "btts"; pick: "yes" | "no" }
  | { market: "ah"; pick: "home" | "away"; line: number }; // line applies to the picked side

export type OddsLeg = { leg: Leg; price: number };
export type EventOdds = {
  id: number;
  home: string;
  away: string;
  date?: string;
  live?: boolean;
  legs: OddsLeg[];
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
    const cands = e.legs
      .map((l) => ({ ...l, ...evalLeg(grid, l.leg, l.price) }))
      .filter((l) => l.binary && l.w >= 0.15 && l.w <= 0.92)
      .sort((x, y) => y.w * y.price - x.w * x.price)
      .slice(0, 14);
    const matchPicks: BuilderPick[] = [];
    for (let k = 2; k <= maxLegs; k++)
      for (const idxs of combosOf(cands.length, k)) {
        const legs = idxs.map((i) => cands[i]);
        if (new Set(legs.map((l) => l.leg.market)).size < legs.length) continue;
        const joint = jointProb(grid, legs.map((l) => l.leg));
        if (joint < 0.03) continue;
        // every leg must constrain the combo given the others — a (nearly) implied leg
        // inflates the price product with edge no bookmaker would actually quote
        let redundant = false;
        for (let i = 0; i < legs.length && !redundant; i++) {
          const rest = legs.filter((_, j) => j !== i).map((l) => l.leg);
          if (joint > 0.98 * jointProb(grid, rest)) redundant = true;
        }
        if (redundant) continue;
        const combinedOdds = legs.reduce((x, l) => x * l.price, 1);
        const naiveProb = legs.reduce((x, l) => x * l.w, 1);
        const edge = joint * combinedOdds - 1;
        if (edge < minEdge) continue;
        matchPicks.push({
          match: `${e.home} vs ${e.away}`,
          date: e.date,
          legs: legs.map((l) => ({
            label: legLabel(l.leg, e.home, e.away),
            odds: l.price,
            modelProb: l.w,
          })),
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
 * Lottery tickets: parlays whose combined odds reach targetOdds, built from
 * model-approved legs. Maximizing log(p)/log(odds) picks the legs that climb
 * toward the target while giving up the least win probability.
 */
export function buildYoloParlays(
  model: MatchModel,
  events: EventOdds[],
  opts: { targetOdds?: number; maxLegs?: number; cap?: number } = {}
): ParlayPick[] {
  const { targetOdds = 1000, maxLegs = 16, cap = 6 } = opts;
  // a ticket can only reach the target within maxLegs if legs average
  // targetOdds^(1/maxLegs); short favorite legs can never compound there
  const minLegOdds = Math.pow(targetOdds, 1 / maxLegs) * 0.95;

  const poolFor = (minLegEdge: number) => {
    type PoolLeg = { match: string; date?: string; label: string; odds: number; p: number; eff: number };
    const pool: PoolLeg[] = [];
    for (const e of events) {
      const grid = model.scoreGrid(e.home, e.away, true);
      let best: PoolLeg | null = null;
      for (const { leg, price } of e.legs) {
        const ev = evalLeg(grid, leg, price);
        if (!ev.binary || price < minLegOdds || ev.w <= 0 || ev.w >= 0.97) continue;
        if (ev.w * price - 1 < minLegEdge) continue;
        const eff = Math.log(ev.w) / Math.log(price); // -1 is a fair leg; higher is better
        if (!best || eff > best.eff)
          best = {
            match: `${e.home} vs ${e.away}`,
            date: e.date,
            label: legLabel(leg, e.home, e.away),
            odds: price,
            p: ev.w,
            eff,
          };
      }
      if (best) pool.push(best);
    }
    return pool.sort((x, y) => y.eff - x.eff);
  };

  // YOLO never comes back empty: prefer +EV legs, relax to near-fair, then to
  // anything on the board — efficiency ranking still favors the model's picks
  const canReach = (p: { odds: number }[]) =>
    p.reduce((s, l) => s + Math.log(l.odds), 0) >= Math.log(targetOdds);
  let pool = poolFor(0);
  if (!canReach(pool)) pool = poolFor(-0.05);
  if (!canReach(pool)) pool = poolFor(-Infinity);

  // disjoint tickets: each takes the best remaining legs until the target is hit
  const out: ParlayPick[] = [];
  let i = 0;
  while (out.length < cap && i < pool.length) {
    const legs: typeof pool = [];
    let odds = 1;
    while (i < pool.length && legs.length < maxLegs && odds < targetOdds) {
      legs.push(pool[i]);
      odds *= pool[i].odds;
      i++;
    }
    if (odds < targetOdds) break;
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
  // best value leg per match — one leg per match keeps legs independent
  type PoolLeg = { match: string; date?: string; label: string; odds: number; p: number; edge: number };
  const pool: PoolLeg[] = [];
  for (const e of events) {
    const grid = model.scoreGrid(e.home, e.away, true);
    let best: PoolLeg | null = null;
    for (const { leg, price } of e.legs) {
      const ev = evalLeg(grid, leg, price);
      if (!ev.binary || ev.w < minLegProb) continue;
      const edge = ev.w * price - 1;
      if (edge >= minLegEdge && (!best || edge > best.edge))
        best = {
          match: `${e.home} vs ${e.away}`,
          date: e.date,
          label: legLabel(leg, e.home, e.away),
          odds: price,
          p: ev.w,
          edge,
        };
    }
    if (best) pool.push(best);
  }
  pool.sort((x, y) => y.edge - x.edge);
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
