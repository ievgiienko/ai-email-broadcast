import { describe, expect, it } from "vitest";
import {
  extractAddress, formatSender, isValidEmail, normalizeEmail, parseAddressBlob,
} from "@/lib/email-address";

describe("normalizeEmail", () => {
  it("lower-cases and trims", () => {
    expect(normalizeEmail("  John.Doe@Example.COM ")).toBe("john.doe@example.com");
  });

  it("does not strip dots or plus tags — they address different mailboxes", () => {
    expect(normalizeEmail("a.b+tag@gmail.com")).toBe("a.b+tag@gmail.com");
  });

  it("makes comparison case-insensitive", () => {
    expect(normalizeEmail("A@B.COM")).toBe(normalizeEmail("a@b.com"));
  });
});

describe("isValidEmail", () => {
  it.each([
    "a@b.co", "john.doe@example.com", "a+tag@sub.domain.example.com",
    "first_last@example-domain.org", "x'y@example.com",
  ])("accepts %s", (value) => expect(isValidEmail(value)).toBe(true));

  it.each([
    "", "  ", "no-at-sign", "@example.com", "a@", "a@b", "a b@example.com",
    "a@@b.com", "a@b..com", "a@-b.com", "a@b.c",
  ])("rejects %j", (value) => expect(isValidEmail(value)).toBe(false));

  it("rejects an over-long address", () => {
    expect(isValidEmail(`${"a".repeat(250)}@example.com`)).toBe(false);
  });

  it("rejects an over-long local part", () => {
    expect(isValidEmail(`${"a".repeat(65)}@example.com`)).toBe(false);
  });
});

describe("extractAddress", () => {
  it("unwraps a display-name form", () => {
    expect(extractAddress("Jane Doe <jane@example.com>")).toBe("jane@example.com");
  });

  it("strips a mailto: prefix", () => {
    expect(extractAddress("mailto:jane@example.com")).toBe("jane@example.com");
  });

  it("strips trailing punctuation", () => {
    expect(extractAddress("jane@example.com,")).toBe("jane@example.com");
    expect(extractAddress("(jane@example.com)")).toBe("jane@example.com");
  });
});

describe("parseAddressBlob", () => {
  it("splits on newlines, commas, semicolons and spaces", () => {
    const { valid } = parseAddressBlob("a@x.com\nb@x.com, c@x.com; d@x.com e@x.com");
    expect(valid).toEqual(["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"]);
  });

  it("separates invalid entries instead of importing them", () => {
    const { valid, invalid } = parseAddressBlob("good@x.com\nnot-an-email\nalso bad@");
    expect(valid).toEqual(["good@x.com"]);
    expect(invalid).toEqual(["not-an-email", "also", "bad@"]);
  });

  it("collapses duplicates case-insensitively, keeping the first form", () => {
    const { valid } = parseAddressBlob("Ann@X.com, ann@x.com, ANN@X.COM");
    expect(valid).toEqual(["Ann@X.com"]);
  });

  it("handles display names and mailto links", () => {
    const { valid } = parseAddressBlob("Jane Doe <jane@x.com>; mailto:bob@x.com");
    expect(valid).toContain("jane@x.com");
    expect(valid).toContain("bob@x.com");
  });

  it("does not report the words of a display name as invalid addresses", () => {
    const { valid, invalid } = parseAddressBlob("Jane Doe <jane@x.com> Bob Roe <bob@x.com>");
    expect(valid).toEqual(["jane@x.com", "bob@x.com"]);
    expect(invalid).toEqual([]);
  });

  it("still reports genuine junk as invalid", () => {
    const { valid, invalid } = parseAddressBlob("ok@x.com not-an-email");
    expect(valid).toEqual(["ok@x.com"]);
    expect(invalid).toEqual(["not-an-email"]);
  });

  it("returns nothing for an empty blob", () => {
    expect(parseAddressBlob("   \n\n  ")).toEqual({ valid: [], invalid: [] });
  });
});

describe("formatSender", () => {
  it("returns a bare address when there is no display name", () => {
    expect(formatSender(null, "a@b.com")).toBe("a@b.com");
  });

  it("quotes and escapes a display name", () => {
    expect(formatSender('Acme "Co"', "a@b.com")).toBe('"Acme \\"Co\\"" <a@b.com>');
  });

  it("cannot be used to inject a second address", () => {
    // A quoted display name keeps a comma inert.
    expect(formatSender("Evil, victim@example.com", "a@b.com"))
      .toBe('"Evil, victim@example.com" <a@b.com>');
  });
});
