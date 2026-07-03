export type Match = {
  date: string;
  home: string;
  away: string;
  hs: number | null;
  as: number | null;
  tournament: string;
  neutral: boolean;
};

const CSV_URL =
  "https://raw.githubusercontent.com/martj42/international_results/master/results.csv";

let cache: { at: number; matches: Match[] } | null = null;
const TTL_MS = 60 * 60 * 1000; // refresh hourly

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export async function loadMatches(force = false): Promise<Match[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.matches;
  const res = await fetch(CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`dataset fetch failed: ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split("\n");
  const matches: Match[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    if (c.length < 9) continue;
    matches.push({
      date: c[0],
      home: c[1],
      away: c[2],
      hs: c[3] === "NA" || c[3] === "" ? null : Number(c[3]),
      as: c[4] === "NA" || c[4] === "" ? null : Number(c[4]),
      tournament: c[5],
      neutral: c[8].toUpperCase() === "TRUE",
    });
  }
  cache = { at: Date.now(), matches };
  return matches;
}
