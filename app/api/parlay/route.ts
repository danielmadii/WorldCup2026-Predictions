import { NextResponse } from "next/server";
import { getModel, fetchWorldCupOdds } from "@/lib/engine";
import { buildBetBuilders, buildParlays, buildYoloParlays } from "@/lib/combo";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const minEdge = Number(q.get("minEdge") ?? 0.05);
  const maxLegs = Math.min(4, Math.max(2, Number(q.get("maxLegs") ?? 3)));
  const idsQ = q.get("ids");
  const ids = idsQ ? new Set(idsQ.split(",").map(Number).filter(Number.isFinite)) : null;
  try {
    const [{ model }, all] = await Promise.all([getModel(), fetchWorldCupOdds()]);
    const events = all.filter((e) => !e.live && (!ids || ids.has(e.id)));
    return NextResponse.json({
      builders: buildBetBuilders(model, events, { minEdge, maxLegs }),
      parlays: buildParlays(model, events, { maxLegs }),
      yolo: buildYoloParlays(model, events),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
