import { relations, sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ enums */

export const smtpSecurityEnum = pgEnum("smtp_security", ["none", "starttls", "tls"]);

export const campaignStatusEnum = pgEnum("campaign_status", [
  "DRAFT",
  "QUEUED",
  "SENDING",
  "PAUSED",
  "COMPLETED",
  "CANCELLED",
]);

/**
 * Delivery state only. Engagement (opens) lives in separate columns so SMTP
 * delivery state is never overwritten by an open event.
 *
 * SUPPRESSED and CANCELLED are additions to the four states in the spec. A
 * recipient can unsubscribe *after* the queue was generated, and a campaign can
 * be cancelled with rows still queued; folding either into FAILED would pollute
 * the failure rate with things that never failed.
 */
export const deliveryStatusEnum = pgEnum("delivery_status", [
  "QUEUED",
  "SENDING",
  "SENT",
  "FAILED",
  "SUPPRESSED",
  "CANCELLED",
]);

export const suppressionReasonEnum = pgEnum("suppression_reason", [
  "UNSUBSCRIBED",
  "MANUAL",
  // Reserved for later; the sending worker already treats every reason equally.
  "HARD_BOUNCE",
  "COMPLAINT",
]);

/* ------------------------------------------------------------------ auth */

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  emailNormalized: text("email_normalized").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("users_email_normalized_key").on(t.emailNormalized)]);

export const sessions = pgTable("sessions", {
  // SHA-256 of the opaque cookie value; the raw token is never stored.
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("sessions_expires_at_idx").on(t.expiresAt)]);

/* -------------------------------------------------------------- settings */

/** Single-row table (id is always 1). */
export const appSettings = pgTable("app_settings", {
  id: integer("id").primaryKey().default(1),
  smtpHost: text("smtp_host"),
  smtpPort: integer("smtp_port"),
  smtpSecurity: smtpSecurityEnum("smtp_security").notNull().default("starttls"),
  smtpUser: text("smtp_user"),
  /** AES-256-GCM ciphertext. Never leaves the server. */
  smtpPasswordEncrypted: text("smtp_password_encrypted"),
  fromEmail: text("from_email"),
  fromName: text("from_name"),
  replyTo: text("reply_to"),
  maxEmailsPerHour: integer("max_emails_per_hour").notNull().default(5000),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------------------------------------- contacts */

export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** As entered/imported, for display. */
  email: text("email").notNull(),
  /** Lower-cased + trimmed. The identity key. */
  emailNormalized: text("email_normalized").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  /** Extension point: future custom fields land here without a migration. */
  customFields: jsonb("custom_fields").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("contacts_email_normalized_key").on(t.emailNormalized),
  index("contacts_created_at_idx").on(t.createdAt),
]);

export const contactLists = pgTable("contact_lists", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const contactListMembers = pgTable("contact_list_members", {
  listId: uuid("list_id").notNull().references(() => contactLists.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.listId, t.contactId] }),
  index("clm_contact_id_idx").on(t.contactId),
]);

/* ----------------------------------------------------------- suppression */

export const suppressions = pgTable("suppressions", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  emailNormalized: text("email_normalized").notNull(),
  reason: suppressionReasonEnum("reason").notNull(),
  note: text("note"),
  /** Which campaign the unsubscribe came from, when known. */
  campaignId: uuid("campaign_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("suppressions_email_normalized_key").on(t.emailNormalized)]);

/* ------------------------------------------------------------- campaigns */

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  subject: text("subject").notNull().default(""),
  fromName: text("from_name"),
  fromEmail: text("from_email"),
  replyTo: text("reply_to"),
  /** Editor document (sanitized HTML) — what the composer loads back. */
  contentHtml: text("content_html").notNull().default(""),
  /** Compiled, sanitized HTML actually mailed (before per-recipient merge). */
  compiledHtml: text("compiled_html").notNull().default(""),
  /** Plain-text alternative; auto-derived unless overridden. */
  textBody: text("text_body"),
  textBodyIsCustom: boolean("text_body_is_custom").notNull().default(false),
  status: campaignStatusEnum("status").notNull().default("DRAFT"),
  totalRecipients: integer("total_recipients").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [
  index("campaigns_status_idx").on(t.status),
  index("campaigns_created_at_idx").on(t.createdAt),
]);

export const campaignLists = pgTable("campaign_lists", {
  campaignId: uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  listId: uuid("list_id").notNull().references(() => contactLists.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.campaignId, t.listId] })]);

export const campaignRecipients = pgTable("campaign_recipients", {
  id: uuid("id").primaryKey().defaultRandom(),
  campaignId: uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  /** Nullable on purpose: deleting a contact must not erase send history. */
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),

  // Snapshot taken at queue-generation time so historical stats never depend
  // on the current contents of a contact list.
  email: text("email").notNull(),
  emailNormalized: text("email_normalized").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  customFields: jsonb("custom_fields").notNull().default(sql`'{}'::jsonb`),

  deliveryStatus: deliveryStatusEnum("delivery_status").notNull().default("QUEUED"),
  attempts: integer("attempts").notNull().default(0),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  /** Retry backoff gate; a row is claimable only once this passes. */
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  lastError: text("last_error"),

  /** Lease held by a worker while the row is SENDING. */
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  claimedBy: text("claimed_by"),

  // Engagement, kept separate from deliveryStatus.
  trackingToken: text("tracking_token").notNull(),
  unsubscribeToken: text("unsubscribe_token").notNull(),
  firstOpenedAt: timestamp("first_opened_at", { withTimezone: true }),
  lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
  openCount: integer("open_count").notNull().default(0),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // THE reliability constraint: one row per address per campaign, ever.
  uniqueIndex("campaign_recipients_campaign_email_key").on(t.campaignId, t.emailNormalized),
  uniqueIndex("campaign_recipients_tracking_token_key").on(t.trackingToken),
  uniqueIndex("campaign_recipients_unsubscribe_token_key").on(t.unsubscribeToken),
  index("campaign_recipients_campaign_status_idx").on(t.campaignId, t.deliveryStatus),
  // Drives the worker's claim query.
  index("campaign_recipients_claim_idx").on(t.deliveryStatus, t.nextAttemptAt),
  index("campaign_recipients_email_idx").on(t.emailNormalized),
]);

/* --------------------------------------------------- smtp rate accounting */

/**
 * One row per SMTP transaction attempt. The rolling-hour count of these rows is
 * the rate limiter's input, so the limit survives restarts and is shared by
 * every concurrent worker.
 */
export const smtpSendLog = pgTable("smtp_send_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("smtp_send_log_occurred_at_idx").on(t.occurredAt)]);

/* ------------------------------------------------------------- relations */

export const contactsRelations = relations(contacts, ({ many }) => ({
  memberships: many(contactListMembers),
}));

export const contactListsRelations = relations(contactLists, ({ many }) => ({
  members: many(contactListMembers),
}));

export const contactListMembersRelations = relations(contactListMembers, ({ one }) => ({
  list: one(contactLists, { fields: [contactListMembers.listId], references: [contactLists.id] }),
  contact: one(contacts, { fields: [contactListMembers.contactId], references: [contacts.id] }),
}));

export const campaignsRelations = relations(campaigns, ({ many }) => ({
  lists: many(campaignLists),
  recipients: many(campaignRecipients),
}));

export const campaignListsRelations = relations(campaignLists, ({ one }) => ({
  campaign: one(campaigns, { fields: [campaignLists.campaignId], references: [campaigns.id] }),
  list: one(contactLists, { fields: [campaignLists.listId], references: [contactLists.id] }),
}));

export const campaignRecipientsRelations = relations(campaignRecipients, ({ one }) => ({
  campaign: one(campaigns, { fields: [campaignRecipients.campaignId], references: [campaigns.id] }),
}));

export type Campaign = typeof campaigns.$inferSelect;
export type CampaignRecipient = typeof campaignRecipients.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type ContactList = typeof contactLists.$inferSelect;
export type AppSettings = typeof appSettings.$inferSelect;
