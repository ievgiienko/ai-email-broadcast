import { describe, expect, it } from "vitest";
import { dedupeCandidates, type CandidateContact } from "@/lib/campaign-recipients";
import { prepareRows } from "@/lib/import";

const contact = (email: string, firstName?: string): CandidateContact => ({
  contactId: null, email, firstName: firstName ?? null, lastName: null, customFields: {},
});

describe("dedupeCandidates", () => {
  it("collapses an address appearing on two lists into one recipient", () => {
    // List A: a, b   List B: b, c   => 3 emails, not 4.
    const listA = [contact("a@example.com"), contact("b@example.com")];
    const listB = [contact("b@example.com"), contact("c@example.com")];

    const { unique, duplicatesRemoved } = dedupeCandidates([...listA, ...listB]);

    expect(unique.map((u) => u.emailNormalized)).toEqual([
      "a@example.com", "b@example.com", "c@example.com",
    ]);
    expect(unique).toHaveLength(3);
    expect(duplicatesRemoved).toBe(1);
  });

  it("compares case-insensitively", () => {
    const { unique, duplicatesRemoved } = dedupeCandidates([
      contact("Bob@Example.com"), contact("bob@example.com"), contact("BOB@EXAMPLE.COM"),
    ]);
    expect(unique).toHaveLength(1);
    expect(duplicatesRemoved).toBe(2);
  });

  it("keeps the first occurrence, so the retained record is deterministic", () => {
    const { unique } = dedupeCandidates([contact("x@y.com", "First"), contact("X@Y.com", "Second")]);
    expect(unique[0].firstName).toBe("First");
  });

  it("ignores blank addresses instead of creating an empty recipient", () => {
    const { unique } = dedupeCandidates([contact("  "), contact("a@b.com")]);
    expect(unique).toHaveLength(1);
  });

  it("handles three overlapping lists", () => {
    const { unique, duplicatesRemoved } = dedupeCandidates([
      contact("a@x.com"), contact("b@x.com"),
      contact("b@x.com"), contact("c@x.com"),
      contact("a@x.com"), contact("c@x.com"), contact("d@x.com"),
    ]);
    expect(unique).toHaveLength(4);
    expect(duplicatesRemoved).toBe(3);
  });

  it("is a no-op on an empty audience", () => {
    expect(dedupeCandidates([])).toEqual({ unique: [], duplicatesRemoved: 0 });
  });
});

describe("prepareRows", () => {
  it("separates valid, invalid and duplicate rows", () => {
    const result = prepareRows([
      { email: "a@x.com" },
      { email: "A@X.com" },
      { email: "nope" },
      { email: "b@x.com" },
      { email: "" },
    ]);
    expect(result.valid.map((r) => r.emailNormalized)).toEqual(["a@x.com", "b@x.com"]);
    expect(result.duplicatesInInput).toBe(1);
    expect(result.invalid).toEqual(["nope"]);
  });

  it("normalizes blank names to null rather than empty strings", () => {
    const [row] = prepareRows([{ email: "a@x.com", firstName: "  ", lastName: " Lee " }]).valid;
    expect(row.firstName).toBeNull();
    expect(row.lastName).toBe("Lee");
  });

  it("preserves the original casing for display", () => {
    const [row] = prepareRows([{ email: "Ann.Lee@Example.com" }]).valid;
    expect(row.email).toBe("Ann.Lee@Example.com");
    expect(row.emailNormalized).toBe("ann.lee@example.com");
  });
});
