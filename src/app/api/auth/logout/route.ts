import { NextResponse } from "next/server";
import { assertSameOrigin, destroySession } from "@/lib/auth";
import { handle } from "@/lib/api";

export async function POST() {
  return handle(async () => {
    await assertSameOrigin();
    await destroySession();
    return NextResponse.json({ ok: true });
  });
}
