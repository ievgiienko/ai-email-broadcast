import sanitizeHtml from "sanitize-html";

/**
 * Sanitization policy for admin-authored email bodies.
 *
 * The admin is trusted-ish, but the composed HTML is stored, re-rendered in the
 * admin UI and mailed out, so scripts/handlers are stripped unconditionally.
 */
const POLICY: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "div", "span", "strong", "b", "em", "i", "u", "s", "strike",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "blockquote", "pre", "code",
    "a", "img", "hr",
    "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  ],
  allowedAttributes: {
    "*": ["style", "align", "dir", "title"],
    a: ["href", "target", "rel", "style", "title"],
    img: ["src", "alt", "width", "height", "style"],
    table: ["width", "cellpadding", "cellspacing", "border", "style", "role"],
    td: ["colspan", "rowspan", "align", "valign", "width", "style"],
    th: ["colspan", "rowspan", "align", "valign", "width", "style"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https", "data", "cid"] },
  allowedStyles: {
    "*": {
      "color": [/^.{0,64}$/],
      "background-color": [/^.{0,64}$/],
      "text-align": [/^(left|right|center|justify)$/],
      "font-size": [/^\d{1,3}(px|pt|em|rem|%)$/],
      "font-weight": [/^(normal|bold|[1-9]00)$/],
      "font-style": [/^(normal|italic)$/],
      "text-decoration": [/^[a-z\s-]{0,40}$/],
      "font-family": [/^[\w\s,'"-]{0,120}$/],
      "margin": [/^[\d\s.a-z%]{0,40}$/],
      "padding": [/^[\d\s.a-z%]{0,40}$/],
      "width": [/^[\d.]{1,8}(px|%|em)$/],
      "max-width": [/^[\d.]{1,8}(px|%|em)$/],
      "line-height": [/^[\d.]{1,6}(px|em|%)?$/],
    },
  },
  transformTags: {
    // Anything leaving in an email opens in a new tab and never leaks a referrer.
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer nofollow" },
    }),
  },
  disallowedTagsMode: "discard",
};

export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, POLICY);
}

/**
 * Very small HTML -> text conversion for the plain-text alternative. Good
 * enough for the simple bodies this editor produces; the admin can override it.
 */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<\s*(br)\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|h[1-6]|li|tr|blockquote)\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<\s*\/\s*(ul|ol|table)\s*>/gi, "\n");

  const linksExpanded = withBreaks.replace(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, label: string) => {
      const text = stripTags(label).trim();
      if (!text) return href;
      return text === href ? href : `${text} (${href})`;
    },
  );

  return decodeEntities(stripTags(linksExpanded))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .trim();
}

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]*>/g, "");
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…",
  };
  return text
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

/** Wraps a body fragment in a minimal, email-client-friendly document. */
export function wrapEmailDocument(bodyHtml: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
<div style="max-width:640px;margin:0 auto;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#18181b;background-color:#ffffff;">
${bodyHtml}
</div>
</body>
</html>`;
}
