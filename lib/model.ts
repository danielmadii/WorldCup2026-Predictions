import type { Match } from "./data";
import { trainElo, eloDiff } from "./elo";

const MAX_GOALS = 10;

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

}
