import { NextResponse } from "next/server";
import { findValueBets } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const minEdge = Number(new URL(req.url).searchParams.get("minEdge") ?? 0.03);
  try {
    const picks = await findValueBets(minEdge);
    return NextResponse.json({ picks });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
