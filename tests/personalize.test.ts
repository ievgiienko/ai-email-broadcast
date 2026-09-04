import { describe, expect, it } from "vitest";
import {
  buildMergeValues, extractVariables, renderTemplate, renderTemplateHtml,
} from "@/lib/personalize";
import { buildMessage } from "@/lib/message-builder";

describe("renderTemplate", () => {
  const values = buildMergeValues({ email: "ann@x.com", firstName: "Ann", lastName: "Lee" });

  it("substitutes the standard variables", () => {
    expect(renderTemplate("Hello {{firstName}} {{lastName}} ({{email}})", values))
      .toBe("Hello Ann Lee (ann@x.com)");
  });

  it("replaces a missing variable with empty text, never the raw placeholder", () => {
    const sparse = buildMergeValues({ email: "x@y.com" });
    const output = renderTemplate("Hello {{firstName}}, welcome.", sparse);
    expect(output).toBe("Hello , welcome.");
    expect(output).not.toContain("{{");
  });

  it("replaces an unknown variable with empty text", () => {
    expect(renderTemplate("Hi {{nickname}}!", values)).toBe("Hi !");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(renderTemplate("Hi {{  firstName  }}", values)).toBe("Hi Ann");
  });

  it("is case-insensitive on the variable name", () => {
    expect(renderTemplate("{{firstname}} {{FIRSTNAME}}", values)).toBe("Ann Ann");
  });

  it("substitutes every occurrence", () => {
    expect(renderTemplate("{{firstName}}{{firstName}}", values)).toBe("AnnAnn");
  });

  it("leaves text with no placeholders untouched", () => {
    expect(renderTemplate("Plain text {} {x} }}{{", values)).toBe("Plain text {} {x} }}{{");
  });
});

describe("buildMergeValues", () => {
  it("exposes custom fields, so new fields need no code change", () => {
    const values = buildMergeValues({
      email: "a@b.com", firstName: "Ann", customFields: { company: "Acme", plan: 3 },
    });
    expect(renderTemplate("{{company}} / {{plan}}", values)).toBe("Acme / 3");
  });

  it("does not let a custom field shadow a built-in", () => {
    const values = buildMergeValues({
      email: "real@x.com", customFields: { email: "spoofed@evil.com" },
    });
    expect(values.email).toBe("real@x.com");
  });

  it("derives fullName", () => {
    expect(buildMergeValues({ email: "a@b.com", firstName: "Ann", lastName: "Lee" }).fullName)
      .toBe("Ann Lee");
  });
});

describe("renderTemplateHtml", () => {
  it("escapes substituted values, so a contact name cannot inject markup", () => {
    const values = buildMergeValues({ email: "a@b.com", firstName: "<script>alert(1)</script>" });
    const output = renderTemplateHtml("<p>Hi {{firstName}}</p>", values);
    expect(output).not.toContain("<script>");
    expect(output).toContain("&lt;script&gt;");
  });
});

describe("extractVariables", () => {
  it("lists the variables a template uses", () => {
    expect(extractVariables("{{firstName}} {{email}} {{firstName}}").sort())
      .toEqual(["email", "firstName"]);
  });
});

describe("buildMessage", () => {
  const campaign = { subject: "Hi {{firstName}}", compiledHtml: "<p>Hello {{firstName}}</p>" };
  const baseUrl = "https://mail.example.test";

  it("personalizes the subject and the body", () => {
    const message = buildMessage({
      campaign,
      recipient: { email: "ann@x.com", firstName: "Ann", trackingToken: "tok", unsubscribeToken: "unsub" },
      baseUrl,
    });
    expect(message.subject).toBe("Hi Ann");
    expect(message.html).toContain("Hello Ann");
  });

  it("injects the tracking pixel with the recipient's token", () => {
    const message = buildMessage({
      campaign,
      recipient: { email: "a@x.com", trackingToken: "TOKEN123", unsubscribeToken: "u" },
      baseUrl,
    });
    expect(message.html).toContain(`${baseUrl}/api/track/open/TOKEN123`);
    expect(message.html).toContain('width="1"');
  });

  it("omits the pixel in preview mode, so previews cannot register an open", () => {
    const message = buildMessage({
      campaign,
      recipient: { email: "a@x.com", trackingToken: "TOKEN123", unsubscribeToken: "u" },
      baseUrl,
      preview: true,
    });
    expect(message.html).not.toContain("/api/track/open/");
  });

  it("omits the mailto: form of List-Unsubscribe when no real address exists", () => {
    const message = buildMessage({
      campaign,
      recipient: { email: "a@x.com", trackingToken: "t", unsubscribeToken: "U" },
      baseUrl,
    });
    expect(message.headers["List-Unsubscribe"]).toBe(`<${baseUrl}/api/unsubscribe/U>`);
    expect(message.headers["List-Unsubscribe"]).not.toContain("mailto:");
  });

  it("includes the mailto: form when a monitored address is supplied", () => {
    const message = buildMessage({
      campaign,
      recipient: { email: "a@x.com", trackingToken: "t", unsubscribeToken: "U" },
      baseUrl,
      unsubscribeMailto: "replies@example.com",
    });
    expect(message.headers["List-Unsubscribe"]).toContain("mailto:replies@example.com");
  });

  it("always includes an unsubscribe link and the List-Unsubscribe headers", () => {
    const message = buildMessage({
      campaign,
      recipient: { email: "a@x.com", trackingToken: "t", unsubscribeToken: "UNSUB9" },
      baseUrl,
    });
    expect(message.html).toContain(`${baseUrl}/unsubscribe/UNSUB9`);
    expect(message.text).toContain(`${baseUrl}/unsubscribe/UNSUB9`);
    expect(message.headers["List-Unsubscribe"]).toContain(`${baseUrl}/api/unsubscribe/UNSUB9`);
    expect(message.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("does not append a second footer when the author placed the link themselves", () => {
    const message = buildMessage({
      campaign: { subject: "s", compiledHtml: '<a href="{{unsubscribeUrl}}">Opt out</a>' },
      recipient: { email: "a@x.com", trackingToken: "t", unsubscribeToken: "UNSUB9" },
      baseUrl,
    });
    expect(message.html.match(/unsubscribe\/UNSUB9/g)).toHaveLength(1);
  });

  it("generates a plain-text alternative from the HTML", () => {
    const message = buildMessage({
      campaign: { subject: "s", compiledHtml: "<h1>Title</h1><p>Body <b>text</b></p>" },
      recipient: { email: "a@x.com", trackingToken: "t", unsubscribeToken: "u" },
      baseUrl,
    });
    expect(message.text).toContain("Title");
    expect(message.text).toContain("Body text");
    expect(message.text).not.toContain("<p>");
  });

  it("prefers a custom plain-text body when one is set", () => {
    const message = buildMessage({
      campaign: { subject: "s", compiledHtml: "<p>HTML</p>", textBody: "Custom for {{firstName}}" },
      recipient: { email: "a@x.com", firstName: "Ann", trackingToken: "t", unsubscribeToken: "u" },
      baseUrl,
    });
    expect(message.text).toContain("Custom for Ann");
    expect(message.text).not.toContain("HTML");
  });
});
