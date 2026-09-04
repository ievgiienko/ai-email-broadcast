import { NextResponse } from "next/server";
import { assertSameOrigin, authenticate, createSession } from "@/lib/auth";
import { handle, readJson, str } from "@/lib/api";

export async function POST(request: Request) {
  return handle(async () => {
    await assertSameOrigin();
    const body = await readJson<{ email?: string; password?: string }>(request);
    const email = str(body.email, "Email", { max: 254 });
    const password = str(body.password, "Password", { max: 512 });

    const user = await authenticate(email, password);
    if (!user) {
      // Deliberately vague: no account enumeration.
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    }
    await createSession(user.id);
    return NextResponse.json({ ok: true });
  });
}
