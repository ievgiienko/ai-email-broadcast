import { NextResponse } from "next/server";
import { badRequest, withAuthMutation } from "@/lib/api";
import { parseCsv, type ColumnRole, type Delimiter } from "@/lib/csv";
import { parseAddressBlob } from "@/lib/email-address";
import { importContacts, MAX_IMPORT_ROWS, type ImportRow } from "@/lib/import";
import { MAX_UPLOAD_BYTES } from "@/lib/limits";

type Body = {
  content?: string;
  delimiter?: string;
  hasHeader?: boolean;
  mapping?: ColumnRole[];
  listId?: string | null;
  /** Treat the whole file as a flat address blob (the .txt path). */
  plain?: boolean;
};

/** Step 4 of the wizard: apply the confirmed mapping and write the contacts. */
export async function POST(request: Request) {
  return withAuthMutation(async () => {
    const body = (await request.json().catch(() => null)) as Body | null;
    if (!body?.content) badRequest("Nothing to import");

    const content = body.content;
    if (Buffer.byteLength(content, "utf8") > MAX_UPLOAD_BYTES) badRequest("File is too large");

    let rows: ImportRow[];
    let invalidCount = 0;
    let invalidSamples: string[] = [];

    if (body.plain) {
      const { valid, invalid } = parseAddressBlob(content);
      rows = valid.map((email) => ({ email }));
      invalidCount = invalid.length;
      invalidSamples = invalid.slice(0, 10);
    } else {
      const delimiter: Delimiter =
        body.delimiter === ";" || body.delimiter === "\t" ? body.delimiter : ",";
      const mapping = Array.isArray(body.mapping) ? body.mapping : [];
      const emailIndex = mapping.indexOf("email");
      if (emailIndex === -1) badRequest("Map one column to Email — it is mandatory");

      const firstIndex = mapping.indexOf("firstName");
      const lastIndex = mapping.indexOf("lastName");

      const parsed = parseCsv(content, delimiter);
      const dataRows = body.hasHeader ? parsed.slice(1) : parsed;
      if (dataRows.length > MAX_IMPORT_ROWS) {
        badRequest(`That file has ${dataRows.length} rows; the limit is ${MAX_IMPORT_ROWS}`);
      }

      rows = dataRows.map((cells) => ({
        email: cells[emailIndex] ?? "",
        firstName: firstIndex >= 0 ? cells[firstIndex] ?? null : null,
        lastName: lastIndex >= 0 ? cells[lastIndex] ?? null : null,
      }));
    }

    const summary = await importContacts(body.listId ?? null, rows);

    return NextResponse.json({
      summary: {
        ...summary,
        invalid: summary.invalid + invalidCount,
        invalidSamples: [...summary.invalidSamples, ...invalidSamples].slice(0, 10),
      },
    });
  });
}
