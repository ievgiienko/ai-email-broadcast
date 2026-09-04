/**
 * Email normalization, validation and bulk parsing.
 *
 * Normalization is deliberately conservative: lower-case + trim only. We do NOT
 * strip Gmail dots or +tags — two addresses that differ there are different
 * mailboxes as far as SMTP is concerned, and silently merging them would drop
 * real recipients.
 */

const EMAIL_RE =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

export function isValidEmail(input: string): boolean {
  const value = input.trim();
  if (value.length === 0 || value.length > 254) return false;
  const at = value.lastIndexOf("@");
  if (at < 1) return false;
  if (value.slice(0, at).length > 64) return false;
  return EMAIL_RE.test(value);
}

/** Strips `Name <addr>` / `mailto:` wrappers and surrounding punctuation. */
export function extractAddress(raw: string): string {
  let value = raw.trim();
  const angled = value.match(/<([^>]+)>/);
  if (angled) value = angled[1];
  value = value.replace(/^mailto:/i, "");
  value = value.replace(/^[\s"'(<[]+/, "").replace(/[\s"')>\].,;:]+$/, "");
  return value.trim();
}

export type ParsedAddresses = {
  valid: string[];
  invalid: string[];
};

/**
 * Splits a blob pasted by a human. Handles newlines, commas, semicolons, tabs
 * and plain spaces as separators, plus `Name <a@b.c>` and markdown-ish noise.
 */
export function parseAddressBlob(blob: string): ParsedAddresses {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  // Collapse `Display Name <addr>` to just the address *before* splitting, so
  // the words of a display name are not reported as invalid entries.
  const flattened = blob.replace(/[^,;\n<>]*<([^>\s]+)>/g, " $1 ");

  const tokens = flattened
    .split(/[\s,;]+/)
    .map((t) => extractAddress(t))
    .filter((t) => t.length > 0);

  for (const token of tokens) {
    if (isValidEmail(token)) {
      const key = normalizeEmail(token);
      if (seen.has(key)) continue;
      seen.add(key);
      valid.push(token.trim());
    } else {
      invalid.push(token);
    }
  }
  return { valid, invalid };
}

/** Formats a display name + address into a valid RFC 5322 From header value. */
export function formatSender(name: string | null | undefined, address: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return address;
  // Quote and escape rather than trying to decide if it needs quoting.
  const escaped = trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}" <${address}>`;
}
