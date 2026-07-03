import { NextResponse } from "next/server";
import { fetchWorldCupOdds } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const events = await fetchWorldCupOdds();
    return NextResponse.json({
      // live matches are listed (so today's games are visible) but flagged —
      // the model only prices pre-match, so they can't be selected for bets
      matches: events.map((e) => ({
        id: e.id,
        home: e.home,
        away: e.away,
        date: e.date,
        live: !!e.live,
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
