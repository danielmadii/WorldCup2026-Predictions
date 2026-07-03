import type { EventOdds, Leg } from "./combo";

export type Anomaly = {
  match: string;
  date?: string;
  live: boolean;
  kind: "arb" | "contradiction" | "mispriced-pair";
  note: string;
  edge: number; // arb: locked-in profit fraction; others: implied-probability gap
};

const ARB_EPS = 0.002; // float noise guard — any true sub-100% book is an arb
const TOL = 0.015; // implied-prob gap before flagging a contradiction
const PAIR_TOL = 0.02; // gap before flagging identically-settling markets

const k = (leg: Leg) =>
  [leg.market, (leg as any).pick, (leg as any).line ?? "", (leg as any).team ?? ""].join("|");

/**
 * Model-free consistency scan: flags prices that are wrong against each other,
 * regardless of any prediction — sub-100% books, implication violations,
 * inverted lines, and equivalent markets priced apart.
 */
export function findAnomalies(events: EventOdds[]): Anomaly[] {
  const out: Anomaly[] = [];
  for (const e of events) {
    const match = `${e.home} vs ${e.away}`;
    const add = (kind: Anomaly["kind"], note: string, edge: number) =>
      out.push({ match, date: e.date, live: !!e.live, kind, note, edge });

    const price = new Map<string, number>();
    for (const l of e.legs) price.set(k(l.leg), l.price);
    const P = (leg: Leg) => price.get(k(leg));
    const imp = (o: number) => 1 / o;

    // a set of prices covering every outcome `coverage` times must sum past coverage
    const arb = (note: string, odds: (number | undefined)[], coverage = 1) => {
      if (odds.some((o) => o === undefined)) return;
      const s = (odds as number[]).reduce((x, o) => x + 1 / o, 0);
      if (s < coverage - ARB_EPS)
        add(
          "arb",
          `${note} (@${(odds as number[]).map((o) => o.toFixed(2)).join(" / @")}) pays out whatever happens`,
          coverage / s - 1
        );
    };

    const home = P({ market: "1x2", pick: "home" });
    const draw = P({ market: "1x2", pick: "draw" });
    const away = P({ market: "1x2", pick: "away" });
    const dc1X = P({ market: "double_chance", pick: "home_or_draw" });
    const dc12 = P({ market: "double_chance", pick: "home_or_away" });
    const dcX2 = P({ market: "double_chance", pick: "draw_or_away" });

    // ---- sub-100% books ----
    arb("Home / Draw / Away", [home, draw, away]);
    arb("Both teams to score yes / no", [
      P({ market: "btts", pick: "yes" }),
      P({ market: "btts", pick: "no" }),
    ]);
    arb("Draw-no-bet both sides", [
      P({ market: "dnb", pick: "home" }),
      P({ market: "dnb", pick: "away" }),
    ]);
    arb("All three double chances", [dc1X, dc12, dcX2], 2);
    arb("Home win / Draw-or-away", [home, dcX2]);
    arb("Away win / Home-or-draw", [away, dc1X]);
    arb("Draw / Home-or-away", [draw, dc12]);

    const totals = new Map<number, { over?: number; under?: number }>();
    const tt: Record<"home" | "away", Map<number, { over?: number; under?: number }>> = {
      home: new Map(),
      away: new Map(),
    };
    const ah: Record<"home" | "away", Map<number, number>> = { home: new Map(), away: new Map() };
    for (const { leg, price: p } of e.legs) {
      if (leg.market === "total") {
        const t = totals.get(leg.line) ?? {};
        t[leg.pick] = p;
        totals.set(leg.line, t);
      } else if (leg.market === "team_total") {
        const t = tt[leg.team].get(leg.line) ?? {};
        t[leg.pick] = p;
        tt[leg.team].set(leg.line, t);
      } else if (leg.market === "ah") ah[leg.pick].set(leg.line, p);
    }
    for (const [line, t] of totals) arb(`Over/Under ${line} goals`, [t.over, t.under]);
    for (const side of ["home", "away"] as const) {
      const team = side === "home" ? e.home : e.away;
      for (const [line, t] of tt[side]) arb(`${team} over/under ${line}`, [t.over, t.under]);
    }
    for (const [line, oh] of ah.home)
      arb(`Asian handicap ${line > 0 ? "+" : ""}${line} both sides`, [oh, ah.away.get(-line)]);
    arb(`Home -0.5 (Asian) / Draw-or-away`, [ah.home.get(-0.5), dcX2]);
    arb(`Away -0.5 (Asian) / Home-or-draw`, [ah.away.get(-0.5), dc1X]);

    // ---- implication violations: A implies B, yet A is priced more likely ----
    const implies = (a: number | undefined, b: number | undefined, la: string, lb: string) => {
      if (!a || !b) return;
      const gap = imp(a) - imp(b);
      if (gap > TOL)
        add("contradiction", `${la} @${a.toFixed(2)} is priced more likely than ${lb} @${b.toFixed(2)}, which it implies`, gap);
    };
    implies(home, dc1X, "Home win", "Home-or-draw");
    implies(home, dc12, "Home win", "Home-or-away");
    implies(away, dcX2, "Away win", "Draw-or-away");
    implies(away, dc12, "Away win", "Home-or-away");
    implies(draw, dc1X, "Draw", "Home-or-draw");
    implies(draw, dcX2, "Draw", "Draw-or-away");
    const o15 = totals.get(1.5)?.over;
    implies(P({ market: "btts", pick: "yes" }), o15, "Both teams to score", "Over 1.5 goals");
    for (const side of ["home", "away"] as const) {
      const team = side === "home" ? e.home : e.away;
      for (const [line, t] of tt[side])
        implies(t.over, totals.get(line)?.over, `${team} over ${line}`, `Match over ${line}`);
    }

    // ---- inverted lines: probability must fall as the bar rises ----
    const mono = (
      entries: [number, number][], // [line, odds], probability must not rise with line
      label: (line: number) => string
    ) => {
      const sorted = entries.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < sorted.length; i++) {
        const [lo, olo] = sorted[i - 1];
        const [hi, ohi] = sorted[i];
        const gap = imp(ohi) - imp(olo);
        if (gap > TOL)
          add("contradiction", `${label(hi)} @${ohi.toFixed(2)} is priced more likely than ${label(lo)} @${olo.toFixed(2)}`, gap);
      }
    };
    mono([...totals].filter(([, t]) => t.over).map(([l, t]) => [l, t.over!]), (l) => `Over ${l} goals`);
    mono(
      [...totals].filter(([, t]) => t.under).map(([l, t]) => [-l, t.under!]),
      (l) => `Under ${-l} goals`
    );
    for (const side of ["home", "away"] as const) {
      const team = side === "home" ? e.home : e.away;
      mono([...tt[side]].filter(([, t]) => t.over).map(([l, t]) => [l, t.over!]), (l) => `${team} over ${l}`);
      mono([...tt[side]].filter(([, t]) => t.under).map(([l, t]) => [-l, t.under!]), (l) => `${team} under ${-l}`);
      // for handicaps a higher line is easier to cover, so probability must not fall
      mono([...ah[side]].map(([l, o]) => [-l, o]), (l) => `${team} ${-l > 0 ? "+" : ""}${-l} (Asian)`);
    }

    // ---- identical-settlement markets priced apart ----
    const twin = (a: number | undefined, b: number | undefined, la: string, lb: string) => {
      if (!a || !b) return;
      const gap = Math.abs(imp(a) - imp(b));
      if (gap > PAIR_TOL)
        add("mispriced-pair", `${la} @${a.toFixed(2)} and ${lb} @${b.toFixed(2)} settle identically — take the bigger price`, gap);
    };
    twin(ah.home.get(-0.5), home, `${e.home} -0.5 (Asian)`, `${e.home} to win`);
    twin(ah.away.get(-0.5), away, `${e.away} -0.5 (Asian)`, `${e.away} to win`);
    twin(ah.home.get(0), P({ market: "dnb", pick: "home" }), `${e.home} 0 (Asian)`, `${e.home} draw-no-bet`);
    twin(ah.away.get(0), P({ market: "dnb", pick: "away" }), `${e.away} 0 (Asian)`, `${e.away} draw-no-bet`);
    twin(ah.home.get(0.5), dc1X, `${e.home} +0.5 (Asian)`, "Home-or-draw");
    twin(ah.away.get(0.5), dcX2, `${e.away} +0.5 (Asian)`, "Draw-or-away");
  }
  const rank = { arb: 0, contradiction: 1, "mispriced-pair": 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || b.edge - a.edge).slice(0, 60);
}
