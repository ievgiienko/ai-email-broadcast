import { NextResponse } from "next/server";
import { badRequest, readJson, withAuthMutation } from "@/lib/api";
import { MAX_PASTE_BYTES } from "@/lib/limits";
import { parseAddressBlob } from "@/lib/email-address";
import { importContacts } from "@/lib/import";



/** Bulk-paste import: newline / comma / semicolon / space separated addresses. */
export async function POST(request: Request) {
  return withAuthMutation(async () => {
    const body = await readJson<{ text?: string; listId?: string | null }>(request);
    const text = typeof body.text === "string" ? body.text : "";
    if (text.length === 0) badRequest("Paste at least one email address");
    if (Buffer.byteLength(text, "utf8") > MAX_PASTE_BYTES) {
      badRequest("That is too much text to paste at once — upload it as a file instead");
    }

    const { valid, invalid } = parseAddressBlob(text);
    const summary = await importContacts(body.listId ?? null, valid.map((email) => ({ email })));

    // parseAddressBlob already collapsed in-input duplicates, so surface its
    // invalid list rather than the (empty) one from prepareRows.
    return NextResponse.json({
      summary: {
        ...summary,
        received: valid.length + invalid.length,
        invalid: invalid.length,
        invalidSamples: invalid.slice(0, 10),
      },
    });
  });
}
