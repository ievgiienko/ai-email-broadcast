import { describe, expect, it } from "vitest";
import {
  detectDelimiter, guessMapping, looksLikeHeader, parseCsv, stripBom,
} from "@/lib/csv";

describe("parseCsv", () => {
  it("parses a simple comma file", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });

  it("keeps delimiters that are inside quotes", () => {
    const rows = parseCsv('email,name\n"a@b.com","Doe, Jane"');
    expect(rows[1]).toEqual(["a@b.com", "Doe, Jane"]);
  });

  it("understands doubled quotes as an escaped quote", () => {
    expect(parseCsv('a\n"say ""hi"""')[1]).toEqual(['say "hi"']);
  });

  it("preserves intentional whitespace inside quotes but trims bare fields", () => {
    const rows = parseCsv('a,b\n  spaced  ,"  kept  "');
    expect(rows[1]).toEqual(["spaced", "  kept  "]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("strips a UTF-8 BOM", () => {
    expect(stripBom("﻿email")).toBe("email");
    expect(parseCsv("﻿email,first\nx@y.com,Ann")[0][0]).toBe("email");
  });

  it("keeps UTF-8 content intact", () => {
    const rows = parseCsv("email,first\nano@example.com,Ольга");
    expect(rows[1]).toEqual(["ano@example.com", "Ольга"]);
  });

  it("drops trailing blank lines but keeps genuinely empty cells", () => {
    const rows = parseCsv("a,b\n1,\n\n");
    expect(rows).toEqual([["a", "b"], ["1", ""]]);
  });

  it("handles semicolon and tab delimiters", () => {
    expect(parseCsv("a;b\n1;2", ";")[1]).toEqual(["1", "2"]);
    expect(parseCsv("a\tb\n1\t2", "\t")[1]).toEqual(["1", "2"]);
  });

  it("tolerates ragged rows rather than throwing", () => {
    expect(parseCsv("a,b,c\n1,2")).toEqual([["a", "b", "c"], ["1", "2"]]);
  });
});

describe("detectDelimiter", () => {
  it("detects commas", () => {
    expect(detectDelimiter("email,first,last\na@b.com,Ann,Lee")).toBe(",");
  });

  it("detects semicolons, as exported by many European CRMs", () => {
    expect(detectDelimiter("email;first;last\na@b.com;Ann;Lee")).toBe(";");
  });

  it("detects tabs", () => {
    expect(detectDelimiter("email\tfirst\na@b.com\tAnn")).toBe("\t");
  });

  it("prefers the delimiter giving a consistent column count", () => {
    // Commas appear inside quoted names but semicolon is the real delimiter.
    const text = 'email;name\na@b.com;"Doe, Jane"\nc@d.com;"Roe, John"';
    expect(detectDelimiter(text)).toBe(";");
  });

  it("falls back to comma for a single-column file", () => {
    expect(detectDelimiter("a@b.com\nc@d.com")).toBe(",");
  });
});

describe("looksLikeHeader", () => {
  it("recognizes a header row", () => {
    expect(looksLikeHeader(["Email", "First Name", "Last Name"])).toBe(true);
  });

  it("rejects a row that already contains an address", () => {
    expect(looksLikeHeader(["a@b.com", "Ann", "Lee"])).toBe(false);
  });
});

describe("guessMapping", () => {
  it("maps common CRM column names", () => {
    expect(guessMapping(["Email Address", "First Name", "Last Name", "Company"]))
      .toEqual(["email", "firstName", "lastName", "ignore"]);
  });

  it("maps localized headers", () => {
    expect(guessMapping(["E-Mail", "Vorname", "Nachname"]))
      .toEqual(["email", "firstName", "lastName"]);
  });

  it("assigns each role at most once", () => {
    const mapping = guessMapping(["email", "email_2", "firstname", "firstname"]);
    expect(mapping.filter((role) => role === "email")).toHaveLength(1);
    expect(mapping.filter((role) => role === "firstName")).toHaveLength(1);
  });

  it("ignores unknown columns", () => {
    expect(guessMapping(["id", "created_at"])).toEqual(["ignore", "ignore"]);
  });
});
