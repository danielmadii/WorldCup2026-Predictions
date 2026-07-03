import { NextResponse } from "next/server";
import { findValueBets } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const minEdge = Number(q.get("minEdge") ?? 0.03);
  const idsQ = q.get("ids");
  const ids = idsQ ? new Set(idsQ.split(",").map(Number).filter(Number.isFinite)) : undefined;
  try {
    const picks = await findValueBets(minEdge, ids);
    return NextResponse.json({ picks });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
