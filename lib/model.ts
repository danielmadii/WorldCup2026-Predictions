import type { Match } from "./data";
import { trainElo, eloDiff } from "./elo";

const MAX_GOALS = 10;

export type Prediction = {
  home: string;
  away: string;
  xg: [number, number];
  p1: number;
  pX: number;
  p2: number;
  over25: number;
  btts: number;
  topScores: [string, number][];
};

function poissonPmf(l: number, max: number): number[] {
  const out = new Array(max + 1);
  out[0] = Math.exp(-l);
  for (let k = 1; k <= max; k++) out[k] = (out[k - 1] * l) / k;
  return out;
}

export class MatchModel {
  ratings: Map<string, number>;
  a = 0.25;
  b = 0.001;

  constructor(matches: Match[], fitSince = "2014-01-01") {
    this.ratings = trainElo(matches);
    this.fit(matches, fitSince);
  }

  /** Newton's method on the convex Poisson GLM negative log-likelihood. */
  private fit(matches: Match[], fitSince: string) {
    const rows: { d: number; hg: number; ag: number }[] = [];
    for (const m of matches) {
      if (m.hs === null || m.as === null || m.date < fitSince) continue;
      rows.push({
        d: eloDiff(this.ratings, m.home, m.away, m.neutral),
        hg: m.hs,
        ag: m.as,
      });
    }
    let a = 0.25,
      b = 0.001;
    for (let it = 0; it < 50; it++) {
      let gA = 0, gB = 0, hAA = 0, hAB = 0, hBB = 0;
      for (const r of rows) {
        const lh = Math.exp(a + b * r.d);
        const la = Math.exp(a - b * r.d);
        gA += lh - r.hg + la - r.ag;
        gB += r.d * (lh - r.hg) - r.d * (la - r.ag);
        hAA += lh + la;
        hAB += r.d * (lh - la);
        hBB += r.d * r.d * (lh + la);
      }
      const det = hAA * hBB - hAB * hAB;
      if (Math.abs(det) < 1e-12) break;
      const dA = (hBB * gA - hAB * gB) / det;
      const dB = (hAA * gB - hAB * gA) / det;
      a -= dA;
      b -= dB;
      if (Math.abs(dA) < 1e-10 && Math.abs(dB) < 1e-12) break;
    }
    this.a = a;
    this.b = b;
  }

  lambdas(home: string, away: string, neutral: boolean): [number, number] {
    const d = eloDiff(this.ratings, home, away, neutral);
    return [Math.exp(this.a + this.b * d), Math.exp(this.a - this.b * d)];
  }

  /** Joint score PMF over 0..MAX_GOALS × 0..MAX_GOALS (independent Poissons). */
  scoreGrid(home: string, away: string, neutral = true): number[][] {
    const [lh, la] = this.lambdas(home, away, neutral);
    const gh = poissonPmf(lh, MAX_GOALS);
    const ga = poissonPmf(la, MAX_GOALS);
    return gh.map((ph) => ga.map((pa) => ph * pa));
  }

  predict(home: string, away: string, neutral = true): Prediction {
    const [lh, la] = this.lambdas(home, away, neutral);
    const gh = poissonPmf(lh, MAX_GOALS);
    const ga = poissonPmf(la, MAX_GOALS);
    let p1 = 0, pX = 0, p2 = 0, over25 = 0, btts = 0;
    const scores: [string, number][] = [];
    for (let h = 0; h <= MAX_GOALS; h++) {
      for (let aG = 0; aG <= MAX_GOALS; aG++) {
        const p = gh[h] * ga[aG];
        if (h > aG) p1 += p;
        else if (h === aG) pX += p;
        else p2 += p;
        if (h + aG >= 3) over25 += p;
        if (h >= 1 && aG >= 1) btts += p;
        if (h < 6 && aG < 6) scores.push([`${h}-${aG}`, p]);
      }
    }
    scores.sort((x, y) => y[1] - x[1]);
    return {
      home,
      away,
      xg: [Math.round(lh * 100) / 100, Math.round(la * 100) / 100],
      p1, pX, p2, over25, btts,
      topScores: scores.slice(0, 5).map(([s, p]) => [s, Math.round(p * 1e4) / 1e4]),
    };
  }

  /** P(home advances): draw mass split by relative strength (ET/pens proxy). */
  koWinProb(home: string, away: string, neutral = true): number {
    const p = this.predict(home, away, neutral);
    return p.p1 + p.p2 > 0 ? p.p1 + p.pX * (p.p1 / (p.p1 + p.p2)) : 0.5;
  }
}

// ---- Monte Carlo tournament simulation ----

export type BracketMatch = { home: string; away: string; neutral: boolean; date?: string };

export function simulateTournament(
  model: MatchModel,
  bracket: BracketMatch[],
  nSims = 20000
): { win: [string, number][]; final: [string, number][] } {
  const champions = new Map<string, number>();
  const finalists = new Map<string, number>();
  const cache = new Map<string, number>();
  const pAdv = (h: string, a: string, neutral = true) => {
    const key = h + "|" + a;
    let v = cache.get(key);
    if (v === undefined) {
      v = model.koWinProb(h, a, neutral);
      cache.set(key, v);
    }
    return v;
  };
  for (const m of bracket) pAdv(m.home, m.away, m.neutral);

  for (let s = 0; s < nSims; s++) {
    let alive: string[] = bracket.map((m) =>
      Math.random() < pAdv(m.home, m.away, m.neutral) ? m.home : m.away
    );
    while (alive.length > 1) {
      let pool = alive;
      const next: string[] = [];
      if (pool.length % 2 === 1) {
        next.push(pool[pool.length - 1]);
        pool = pool.slice(0, -1);
      }
      for (let i = 0; i < pool.length; i += 2) {
        const h = pool[i], a = pool[i + 1];
        next.push(Math.random() < pAdv(h, a) ? h : a);
      }
      if (alive.length === 2)
        for (const t of alive) finalists.set(t, (finalists.get(t) ?? 0) + 1);
      alive = next;
    }
    champions.set(alive[0], (champions.get(alive[0]) ?? 0) + 1);
  }
  const toSorted = (m: Map<string, number>): [string, number][] =>
    [...m.entries()].map(([t, c]): [string, number] => [t, c / nSims]).sort((x, y) => y[1] - x[1]);
  return { win: toSorted(champions), final: toSorted(finalists) };
}
