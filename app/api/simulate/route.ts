import { NextResponse } from "next/server";
import { getModel, upcomingWorldCup } from "@/lib/engine";
import { simulateTournament, type BracketMatch } from "@/lib/model";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const nSims = Math.min(Number(body.nSims) || 20000, 100000);
  const { model, matches } = await getModel();
  const bracket: BracketMatch[] =
    Array.isArray(body.bracket) && body.bracket.length
      ? body.bracket
      : upcomingWorldCup(matches).map((m) => ({
          home: m.home,
          away: m.away,
          neutral: m.neutral,
          date: m.date,
        }));
  const res = simulateTournament(model, bracket, nSims);
  return NextResponse.json({ nSims, bracket, ...res });
}
