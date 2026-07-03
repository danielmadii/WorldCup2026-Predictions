import { NextResponse } from "next/server";
import { getModel } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const { home, away, neutral = true } = await req.json();
  if (!home || !away)
    return NextResponse.json({ error: "home and away are required" }, { status: 400 });
  const { model } = await getModel();
  return NextResponse.json({
    pred: model.predict(home, away, neutral),
    koWinProb: model.koWinProb(home, away, neutral),
  });
}
