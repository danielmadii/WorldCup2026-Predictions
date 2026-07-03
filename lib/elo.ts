import type { Match } from "./data";

export const HOME_ADV = 60;

const K_BY_TOURNAMENT: [string, number][] = [
  ["fifa world cup qualification", 40],
  ["fifa world cup", 60],
  ["uefa euro", 50],
  ["copa américa", 50],
  ["african cup of nations", 50],
  ["afc asian cup", 50],
  ["concacaf championship", 50],
  ["gold cup", 50],
  ["uefa nations league", 40],
  ["concacaf nations league", 35],
  ["confederations cup", 50],
  ["friendly", 20],
];

function kFactor(t: string): number {
  const s = t.toLowerCase();
  for (const [key, k] of K_BY_TOURNAMENT) if (s.includes(key)) return k;
  return 30;
}

function goalMult(margin: number): number {
  if (margin <= 1) return 1;
  if (margin === 2) return 1.5;
  return (11 + margin) / 8;
}

export function expectedScore(a: number, b: number): number {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

export function trainElo(matches: Match[], base = 1500): Map<string, number> {
  const r = new Map<string, number>();
  const played = matches
    .filter((m) => m.hs !== null && m.as !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const m of played) {
    const rh = r.get(m.home) ?? base;
    const ra = r.get(m.away) ?? base;
    const adv = m.neutral ? 0 : HOME_ADV;
    const eh = expectedScore(rh + adv, ra);
    const sh = m.hs! > m.as! ? 1 : m.hs! === m.as! ? 0.5 : 0;
    const k = kFactor(m.tournament) * goalMult(Math.abs(m.hs! - m.as!));
    const d = k * (sh - eh);
    r.set(m.home, rh + d);
    r.set(m.away, ra - d);
  }
  return r;
}

export function eloDiff(
  ratings: Map<string, number>,
  home: string,
  away: string,
  neutral: boolean
): number {
  const adv = neutral ? 0 : HOME_ADV;
  return (ratings.get(home) ?? 1500) + adv - (ratings.get(away) ?? 1500);
}
