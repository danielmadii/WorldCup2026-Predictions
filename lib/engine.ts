import { loadMatches, upcomingWorldCup, type Match } from "./data";
import { MatchModel } from "./model";

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

export function kelly(p: number, odds: number): number {
  const b = odds - 1;
  return b > 0 ? Math.max(0, (p * odds - 1) / b) : 0;
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
  const { model } = await getModel();
  const sport = await cb("/v2/odds/sports/soccer");
  let compKey: string | null = null;
  for (const cat of sport.categories ?? [])
    for (const comp of cat.competitions ?? [])
      if (comp.key.includes("world-cup") && !comp.key.includes("women"))
        compKey = comp.key;
  if (!compKey) throw new Error("World Cup competition not found on Cloudbet");

  const comp = await cb(`/v2/odds/competitions/${compKey}`);
  const picks: ValuePick[] = [];
  for (const ev of comp.events ?? []) {
    let event: any;
    try {
      event = await cb(`/v2/odds/events/${ev.id}`);
    } catch {
      continue;
    }
    const market = event?.markets?.["soccer.match_odds"];
    if (!market) continue;
    const odds: Record<string, number> = {};
    for (const sub of Object.values<any>(market.submarkets ?? {}))
      for (const sel of sub.selections ?? [])
        odds[sel.outcome] = Number(sel.price);
    const home = norm(ev.home?.name ?? "");
    const away = norm(ev.away?.name ?? "");
    if (!home || !away) continue;
    const pred = model.predict(home, away, true);
    const probs: Record<string, number> = { home: pred.p1, draw: pred.pX, away: pred.p2 };
    for (const [outcome, p] of Object.entries(probs)) {
      const o = odds[outcome];
      if (!o) continue;
      const evEdge = p * o - 1;
      if (evEdge >= minEdge)
        picks.push({
          match: `${home} vs ${away}`,
          date: ev.cutoffTime ?? undefined,
          bet: outcome,
          odds: o,
          modelProb: p,
          impliedProb: 1 / o,
          ev: evEdge,
          kellyQuarter: kelly(p, o) / 4,
        });
    }
  }
  return picks.sort((a, b) => b.ev - a.ev);
}
