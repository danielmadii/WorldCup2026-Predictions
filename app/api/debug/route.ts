import { NextResponse } from "next/server";
import { debugWorldCup } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    return NextResponse.json(await debugWorldCup());
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
