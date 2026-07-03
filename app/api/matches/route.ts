import { NextResponse } from "next/server";
import { fetchWorldCupOdds } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const events = await fetchWorldCupOdds();
    return NextResponse.json({
      matches: events
        .filter((e) => !e.live) // live matches can't go on a slip built in advance
        .map((e) => ({ id: e.id, home: e.home, away: e.away, date: e.date })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
