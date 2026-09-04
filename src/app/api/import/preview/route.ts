import { NextResponse } from "next/server";
import { badRequest, withAuthMutation } from "@/lib/api";
import { MAX_UPLOAD_BYTES } from "@/lib/limits";
import { detectDelimiter, guessMapping, looksLikeHeader, parseCsv, type Delimiter } from "@/lib/csv";

/**
 * Step 1-3 of the CSV wizard: read the file, sniff the delimiter and header,
 * and return a preview plus a suggested column mapping. Nothing is written.
 */
export async function POST(request: Request) {
  return withAuthMutation(async () => {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) badRequest("No file uploaded");
    if (file.size === 0) badRequest("That file is empty");
    if (file.size > MAX_UPLOAD_BYTES) {
      badRequest(`File is too large (limit ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB)`);
    }

    const name = file.name.toLowerCase();
    if (!name.endsWith(".csv") && !name.endsWith(".txt")) {
      badRequest("Only .csv and .txt files are supported");
    }

    // Always decoded as UTF-8; a BOM is stripped by the parser.
    const text = new TextDecoder("utf-8").decode(await file.arrayBuffer());
    const requested = form.get("delimiter");
    const delimiter: Delimiter =
      requested === "," || requested === ";" || requested === "\t"
        ? requested
        : detectDelimiter(text);

    const rows = parseCsv(text, delimiter);
    if (rows.length === 0) badRequest("No rows found in that file");

    const hasHeader = looksLikeHeader(rows[0]);
    const header = hasHeader ? rows[0] : rows[0].map((_c, i) => `Column ${i + 1}`);
    const dataRows = hasHeader ? rows.slice(1) : rows;

    return NextResponse.json({
      delimiter,
      hasHeader,
      header,
      mapping: guessMapping(header),
      preview: dataRows.slice(0, 10),
      totalRows: dataRows.length,
      // Echoed back so the confirm step doesn't need a second upload.
      content: text.length <= MAX_UPLOAD_BYTES ? text : "",
    });
  });
}
