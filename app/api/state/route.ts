import { NextResponse } from "next/server";
import { getModel, upcomingWorldCup } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get("refresh") === "1";
  const { model, matches, at } = await getModel(force);
  const upcoming = upcomingWorldCup(matches).map((m) => ({
    ...m,
    pred: model.predict(m.home, m.away, m.neutral),
  }));
  const ratings = [...model.ratings.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([team, elo]) => ({ team, elo: Math.round(elo * 10) / 10 }));
  const played = matches.filter(
    (m) => m.tournament === "FIFA World Cup" && m.date >= "2026-06-01" && m.hs !== null
  ).length;
  return NextResponse.json({
    trainedAt: at,
    coef: { a: model.a, b: model.b },
    ratings,
    upcoming,
    tournament: { played, remaining: upcoming.length },
  });
}
