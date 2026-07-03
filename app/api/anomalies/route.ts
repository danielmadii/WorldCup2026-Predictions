import { NextResponse } from "next/server";
import { fetchWorldCupOdds } from "@/lib/engine";
import { findAnomalies } from "@/lib/anomaly";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const events = await fetchWorldCupOdds();
    return NextResponse.json({ anomalies: findAnomalies(events) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
