/**
 * Minimal RFC 4180 CSV reader with delimiter sniffing.
 *
 * Written by hand rather than pulled in as a dependency because the exact
 * failure modes (quoted delimiters, CRLF, BOM, ragged rows) are the ones we
 * need to pin down in tests.
 */

export type Delimiter = "," | ";" | "\t";

export const DELIMITERS: Delimiter[] = [",", ";", "\t"];

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Picks the delimiter that yields the most consistent column count across the
 * first few lines, breaking ties by column count then by preference order.
 */
export function detectDelimiter(text: string): Delimiter {
  const sample = stripBom(text).split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, 20);
  if (sample.length === 0) return ",";

  let best: { delimiter: Delimiter; score: number; columns: number } | null = null;

  for (const delimiter of DELIMITERS) {
    const counts = sample.map((line) => parseCsv(line, delimiter)[0]?.length ?? 0);
    const columns = counts[0] ?? 0;
    if (columns < 2) continue;
    const consistent = counts.filter((c) => c === columns).length / counts.length;
    const score = consistent * 100 + columns;
    if (!best || score > best.score) best = { delimiter, score, columns };
  }
  return best?.delimiter ?? ",";
}

/** Parses the whole document into rows of raw string cells. */
export function parseCsv(text: string, delimiter: Delimiter = ","): string[][] {
  const input = stripBom(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldWasQuoted = false;

  const pushField = () => {
    row.push(fieldWasQuoted ? field : field.trim());
    field = "";
    fieldWasQuoted = false;
  };
  const pushRow = () => {
    pushField();
    // Drop rows that are entirely empty (trailing newline, blank separators).
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.trim() === "") {
      inQuotes = true;
      fieldWasQuoted = true;
      field = "";
      continue;
    }
    if (char === delimiter) {
      pushField();
      continue;
    }
    if (char === "\r") continue;
    if (char === "\n") {
      pushRow();
      continue;
    }
    field += char;
  }

  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

const HEADER_HINTS = [
  "email", "e-mail", "mail", "first", "last", "name", "vorname", "nachname",
  "prenom", "nom", "correo", "телефон", "имя",
];

/**
 * Heuristic: the first row is a header if no cell looks like an email address
 * and at least one cell reads like a known column label.
 */
export function looksLikeHeader(row: string[]): boolean {
  if (row.length === 0) return false;
  const cells = row.map((c) => c.trim().toLowerCase());
  if (cells.some((c) => c.includes("@") && c.includes("."))) return false;
  return cells.some((c) => HEADER_HINTS.some((hint) => c.includes(hint)));
}

export type ColumnRole = "email" | "firstName" | "lastName" | "ignore";

/** Best-effort auto-mapping of header labels to contact fields. */
export function guessMapping(header: string[]): ColumnRole[] {
  const used = new Set<ColumnRole>();
  return header.map((raw) => {
    const label = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
    const pick = (role: ColumnRole): ColumnRole => {
      if (used.has(role)) return "ignore";
      used.add(role);
      return role;
    };
    if (/^(e?mail|emailaddress|mailaddress|correo|courriel)$/.test(label) || label.includes("email")) {
      return pick("email");
    }
    if (/^(first(name)?|givenname|forename|vorname|prenom|nombre)$/.test(label)) return pick("firstName");
    if (/^(last(name)?|surname|familyname|nachname|apellido)$/.test(label)) return pick("lastName");
    if (label === "name" || label === "fullname") return pick("firstName");
    return "ignore";
  });
}
