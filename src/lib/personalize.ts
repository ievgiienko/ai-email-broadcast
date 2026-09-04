/**
 * `{{variable}}` substitution.
 *
 * Unknown or empty variables render as an empty string — never as the raw
 * placeholder, which is the one outcome recipients must never see.
 */

export type MergeSource = {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  customFields?: Record<string, unknown> | null;
};

export type MergeValues = Record<string, string>;

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/** Builds the variable map. Custom fields extend it without code changes. */
export function buildMergeValues(source: MergeSource, extra: MergeValues = {}): MergeValues {
  const values: MergeValues = {
    email: source.email ?? "",
    firstName: source.firstName ?? "",
    lastName: source.lastName ?? "",
  };
  values.fullName = [values.firstName, values.lastName].filter(Boolean).join(" ");

  for (const [key, value] of Object.entries(source.customFields ?? {})) {
    if (value === null || value === undefined) continue;
    if (key in values) continue; // built-ins win
    values[key] = String(value);
  }
  return { ...values, ...extra };
}

/** Case-insensitive lookup so `{{firstname}}` and `{{firstName}}` both work. */
function lookup(values: MergeValues, name: string): string | undefined {
  if (name in values) return values[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(values)) {
    if (key.toLowerCase() === lower) return values[key];
  }
  return undefined;
}

export function renderTemplate(template: string, values: MergeValues): string {
  return template.replace(PLACEHOLDER_RE, (_match, name: string) => lookup(values, name) ?? "");
}

/** HTML-escaping variant, for substitution inside an HTML body. */
export function renderTemplateHtml(template: string, values: MergeValues): string {
  return template.replace(PLACEHOLDER_RE, (_match, name: string) =>
    escapeHtml(lookup(values, name) ?? ""),
  );
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Variables referenced by a template, for showing the admin what's in use. */
export function extractVariables(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_RE)) found.add(match[1]);
  return [...found];
}
