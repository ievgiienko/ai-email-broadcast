/** Upload and import ceilings, kept in one place so the UI and API agree. */
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024);
export const MAX_PASTE_BYTES = 2 * 1024 * 1024;
