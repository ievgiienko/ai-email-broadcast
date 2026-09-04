import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, hashPassword, randomToken, safeEqual, verifyPassword } from "@/lib/crypto";
import { htmlToText, sanitizeEmailHtml } from "@/lib/html";

describe("SMTP credential encryption", () => {
  it("round-trips a password", () => {
    const blob = encryptSecret("hunter2-and-then-some");
    expect(decryptSecret(blob)).toBe("hunter2-and-then-some");
  });

  it("never stores the plaintext", () => {
    expect(encryptSecret("hunter2")).not.toContain("hunter2");
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("rejects a tampered ciphertext instead of returning garbage", () => {
    const blob = encryptSecret("secret");
    const parts = blob.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });

  it("rejects a malformed blob", () => {
    expect(() => decryptSecret("not-a-blob")).toThrow("Malformed");
  });

  it("handles unicode and long passwords", () => {
    const password = "пароль-🔐-".repeat(20);
    expect(decryptSecret(encryptSecret(password))).toBe(password);
  });
});

describe("password hashing", () => {
  it("verifies the correct password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects a wrong password", () => {
    expect(verifyPassword("wrong", hashPassword("right"))).toBe(false);
  });

  it("salts, so identical passwords hash differently", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("returns false rather than throwing on a corrupt stored hash", () => {
    expect(verifyPassword("x", "garbage")).toBe(false);
    expect(verifyPassword("x", "")).toBe(false);
  });
});

describe("token generation", () => {
  it("produces URL-safe tokens with 256 bits of entropy", () => {
    const token = randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it("does not repeat", () => {
    const tokens = new Set(Array.from({ length: 2000 }, () => randomToken(32)));
    expect(tokens.size).toBe(2000);
  });
});

describe("safeEqual", () => {
  it("matches identical secrets and rejects everything else", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("sanitizeEmailHtml", () => {
  it("strips script tags", () => {
    expect(sanitizeEmailHtml('<p>ok</p><script>alert(1)</script>')).toBe("<p>ok</p>");
  });

  it("strips inline event handlers", () => {
    const output = sanitizeEmailHtml('<p onclick="steal()">text</p>');
    expect(output).not.toContain("onclick");
    expect(output).toContain("text");
  });

  it("strips javascript: URLs", () => {
    const output = sanitizeEmailHtml('<a href="javascript:alert(1)">click</a>');
    expect(output).not.toContain("javascript:");
  });

  it("strips iframes, objects and forms", () => {
    const output = sanitizeEmailHtml('<iframe src="x"></iframe><object></object><form></form><p>kept</p>');
    expect(output).toBe("<p>kept</p>");
  });

  it("keeps the formatting the editor produces", () => {
    const input = "<h2>Title</h2><p><strong>Bold</strong> <em>italic</em> <u>underline</u></p><ul><li>one</li></ul>";
    const output = sanitizeEmailHtml(input);
    expect(output).toContain("<h2>Title</h2>");
    expect(output).toContain("<strong>Bold</strong>");
    expect(output).toContain("<li>one</li>");
  });

  it("keeps safe links but forces noopener and a new tab", () => {
    const output = sanitizeEmailHtml('<a href="https://example.com">link</a>');
    expect(output).toContain('href="https://example.com"');
    expect(output).toContain('rel="noopener noreferrer nofollow"');
  });

  it("keeps mailto links", () => {
    expect(sanitizeEmailHtml('<a href="mailto:a@b.com">mail</a>')).toContain("mailto:a@b.com");
  });

  it("keeps allowed inline styles and drops the rest", () => {
    const output = sanitizeEmailHtml('<p style="color:#ff0000;position:fixed">x</p>');
    expect(output).toContain("color:#ff0000");
    expect(output).not.toContain("position");
  });

  it("leaves merge placeholders intact for later substitution", () => {
    expect(sanitizeEmailHtml("<p>Hi {{firstName}}</p>")).toContain("{{firstName}}");
  });
});

describe("htmlToText", () => {
  it("converts block elements to line breaks", () => {
    expect(htmlToText("<h1>Title</h1><p>One</p><p>Two</p>")).toBe("Title\nOne\nTwo");
  });

  it("expands links so the URL survives", () => {
    expect(htmlToText('<p>See <a href="https://x.com/a">our site</a></p>'))
      .toContain("our site (https://x.com/a)");
  });

  it("does not repeat a link whose text is already the URL", () => {
    expect(htmlToText('<a href="https://x.com">https://x.com</a>')).toBe("https://x.com");
  });

  it("renders list items as bullets", () => {
    expect(htmlToText("<ul><li>one</li><li>two</li></ul>")).toContain("- one");
  });

  it("decodes entities", () => {
    expect(htmlToText("<p>Tom &amp; Jerry &mdash; &quot;hi&quot;</p>")).toBe('Tom & Jerry — "hi"');
  });

  it("never leaks script contents into the text part", () => {
    expect(htmlToText("<p>ok</p><script>alert(1)</script>")).toBe("ok");
  });

  it("collapses runs of blank lines", () => {
    expect(htmlToText("<p>a</p><p></p><p></p><p>b</p>")).toBe("a\n\nb");
  });
});
