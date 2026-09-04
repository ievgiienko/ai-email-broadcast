# Mailer — a small self-hosted email campaign manager

Import contacts, compose a campaign, send it through your own SMTP account at a
controlled rate, and track delivery and opens. It is deliberately much smaller
than Mailchimp or SendPulse's marketing platform: one admin, one database, one
web app.

Built with Next.js (App Router) + TypeScript + PostgreSQL + Drizzle + Nodemailer.
It is provider-agnostic — SendPulse is just a set of SMTP settings.

---

## Contents

- [Quick start](#quick-start)
- [Configuring SendPulse SMTP](#configuring-sendpulse-smtp)
- [How the sending queue and rate limit work](#how-the-sending-queue-and-rate-limit-work)
- [Never sending the same email twice](#never-sending-the-same-email-twice)
- [Open tracking, and what it does not tell you](#open-tracking-and-what-it-does-not-tell-you)
- [Unsubscribes and the suppression list](#unsubscribes-and-the-suppression-list)
- [Deployment](#deployment)
- [Architecture and trade-offs](#architecture-and-trade-offs)
- [Environment variables](#environment-variables)
- [Development](#development)
- [Security notes](#security-notes)

---

## Quick start

Requirements: Node 22+, Docker (for local Postgres), and an SMTP account.

```bash
npm install
cp .env.example .env
```

Fill in `.env`. At minimum, generate the two secrets:

```bash
openssl rand -hex 32   # ENCRYPTION_KEY
openssl rand -hex 32   # WORKER_SECRET
```

Start the database, apply migrations, and create your admin account:

```bash
docker compose up -d db
npm run db:migrate
npm run create-admin -- you@example.com 'a-long-password-you-will-remember'
```

Run it:

```bash
npm run dev
```

Open http://localhost:3000, sign in, and go to **Settings** to configure SMTP.

To actually send, something must call the worker endpoint on a schedule. In
development, run this in a second terminal:

```bash
npm run worker
```

That is a plain loop that POSTs to `/api/worker/tick` every minute — exactly what
a cron job would do in production.

---

## Configuring SendPulse SMTP

In SendPulse, open **Settings → SMTP** and generate SMTP credentials (these are
*not* your SendPulse account login). Then in this app's **Settings** page:

| Field | Value |
| --- | --- |
| Hostname | `smtp-pulse.com` |
| Port | `587` (STARTTLS) or `465` (TLS/SSL) |
| Encryption | `STARTTLS` for 587, `TLS/SSL` for 465 |
| Username | your SendPulse SMTP login |
| Password | your SendPulse SMTP password |
| Sender email | an address **verified as a sender in SendPulse** |
| Sender display name | e.g. `Example News` |
| Maximum emails per hour | `5000` |

There are preset buttons on the page for both SendPulse port options.

Then use **Test connection** (opens an SMTP session and authenticates, sends
nothing) and **Send test email** (sends a real message). If the sender address is
not verified in SendPulse, the test will fail with a 5xx from their server — the
error is shown verbatim, minus any credentials.

The password is encrypted with AES-256-GCM using `ENCRYPTION_KEY` before it is
stored, and is never sent back to the browser: the settings API returns only
`smtpPasswordSet: true`.

**Any standard SMTP server works.** Nothing about SendPulse is special-cased in
the code; it is all configuration.

---

## How the sending queue and rate limit work

### The queue

Queuing a campaign does not send anything. It writes one `campaign_recipients`
row per unique recipient, each with a snapshot of the contact, a delivery status,
and two random tokens (tracking + unsubscribe). **The database is the only source
of truth.** Nothing lives in process memory, so restarts, crashes and serverless
timeouts cost nothing.

A worker invocation (`POST /api/worker/tick`) does this and then returns:

1. Return rows whose worker lease expired back to `QUEUED` (crash recovery).
2. Read how many SMTP attempts were logged in the last rolling hour.
3. Compute a batch size from the remaining hourly allowance.
4. Claim that many due recipients **atomically**.
5. Re-check the suppression list.
6. Send them, with a small amount of parallelism.
7. Mark each row `SENT`, `FAILED`, or re-queue it with a backoff.
8. Stop when the queue is empty, the hour's quota is spent, or the time budget
   runs out.

The claim in step 4 is a single statement:

```sql
WITH due AS (
  SELECT r.id FROM campaign_recipients r
  JOIN campaigns c ON c.id = r.campaign_id
  WHERE r.delivery_status = 'QUEUED'
    AND r.next_attempt_at <= now()
    AND c.status IN ('QUEUED', 'SENDING')
  ORDER BY r.next_attempt_at, r.created_at
  LIMIT $1
  FOR UPDATE OF r SKIP LOCKED      -- concurrent workers get disjoint rows
)
UPDATE campaign_recipients r
SET delivery_status = 'SENDING',
    attempts        = r.attempts + 1,
    lease_expires_at = now() + interval '5 minutes',
    claimed_by      = $2
FROM due, campaigns c2
WHERE r.id = due.id AND c2.id = r.campaign_id
RETURNING ...
```

`FOR UPDATE ... SKIP LOCKED` is what makes overlapping cron invocations safe: two
workers firing at the same instant partition the queue rather than both grabbing
the same recipient.

### The rate limit

`SMTP_MAX_EMAILS_PER_HOUR` (default `5000`, matching SendPulse) is the ceiling.
Two things keep the app under it:

**A rolling window, not a clock hour.** Every SMTP attempt inserts a row into
`smtp_send_log`. The limiter counts rows in the last 60 minutes. Resetting on the
hour would allow a 2× burst across the boundary — 5,000 at 10:59 and another
5,000 at 11:01.

**A safety margin.** `SMTP_RATE_SAFETY_FACTOR` (default `0.95`) means the app
aims for 4,750/hour, leaving room for the small overshoot that is possible when
several workers reserve quota simultaneously.

**Quota is spread across ticks.** A tick does not drain the whole hour's budget
at once. It takes at most `effectiveLimit × tickInterval / 3600` — about 79
emails on a 60-second cron — so sending is paced rather than bursty.

For 20,000 recipients at 5,000/hour, expect roughly 4 hours 13 minutes. The
confirmation screen shows this estimate before you commit.

### Failure handling

Up to `SMTP_MAX_ATTEMPTS` (default 3) attempts per recipient, backing off 1 → 5 →
15 minutes. After the last attempt the recipient is `FAILED` with a short,
credential-scrubbed error, and the campaign carries on — one bad address can
never block the rest.

- **5xx replies** (bad mailbox, rejected sender) are permanent: failed
  immediately, no retries wasted.
- **4xx replies and socket errors** are temporary and retried.
- **Unknown errors are treated as temporary**, because wrongly calling something
  permanent silently drops a real recipient.
- **Authentication and connection failures abort the whole batch** and release
  the claimed rows without consuming an attempt. These are configuration
  problems, not recipient problems; failing 200 people because a password
  expired would be wrong.

Failed addresses can be exported as CSV from the campaign page.

### Pause / resume / cancel

The worker only claims from campaigns whose status is `QUEUED` or `SENDING`.

- **Pause** flips the status to `PAUSED`. Queued rows are not touched at all —
  they simply stop being claimed, and resume exactly where they stopped.
- **Cancel** flips the status to `CANCELLED` and moves the remaining queued rows
  to `CANCELLED` too — a distinct state from `FAILED`, so a cancellation never
  inflates the failure rate.
- Messages already handed to the SMTP server cannot be recalled. Rows currently
  `SENDING` are left to resolve on their own.

---

## Never sending the same email twice

This is the constraint the schema and the worker are built around.

1. **`UNIQUE(campaign_id, email_normalized)`.** One row per address per campaign,
   enforced by the database. Recipient generation uses `ON CONFLICT DO NOTHING`,
   so a double-clicked Send button or a retried HTTP request cannot duplicate the
   queue.
2. **The `DRAFT → QUEUED` transition is a conditional `UPDATE`.** Only one
   concurrent request can win; the loser gets a 409.
3. **Claiming is atomic and increments `attempts` before any SMTP traffic.** A
   row is accounted for even if the process dies immediately afterwards.
4. **Terminal updates are conditional on still being `SENDING`.** A late write
   from a worker that already lost its lease cannot resurrect or overwrite a row.
5. **Deduplication is case-insensitive**, so `Bob@Example.com` and
   `bob@example.com` are one recipient.

### The edge case that cannot be removed

SMTP has no transactional handshake with your database. There is a window
between "the SMTP server accepted the message" and "we committed `SENT`". If the
process dies inside that window, the lease eventually expires, the row returns to
`QUEUED`, and **that one recipient may receive the message twice.**

This is inherent to at-least-once delivery over SMTP — every mailer has it. What
this design guarantees is that the window is small (one database round-trip) and
bounded (`attempts` is incremented at claim time, so even a pathologically
crash-looping row exhausts its retries and stops rather than sending forever).

Eliminating it entirely would require a two-phase commit with the SMTP provider,
which SMTP does not offer.

---

## Open tracking, and what it does not tell you

Every recipient gets a 256-bit random `tracking_token` — never a sequential
database id, so opens cannot be enumerated or forged for someone else. A 1×1
transparent GIF is injected into the outgoing HTML:

```html
<img src="https://your-app.example.com/api/track/open/TOKEN" width="1" height="1" ...>
```

On request the endpoint does one `UPDATE` and returns the image:

```sql
UPDATE campaign_recipients
SET first_opened_at = COALESCE(first_opened_at, now()),   -- set once, ever
    last_opened_at  = now(),
    open_count      = open_count + 1
WHERE tracking_token = $1
```

`COALESCE` is what separates **unique opens** (`first_opened_at IS NOT NULL`)
from **total opens** (`open_count`). Requesting the pixel ten times is one unique
open and ten total opens.

Engagement is stored in its own columns. It never touches `delivery_status`, so
an open cannot overwrite delivery state.

### Limitations — please read before trusting the numbers

Open tracking is **approximate, and biased in both directions**:

- Most mail clients block remote images by default. Those readers are invisible:
  someone can read the whole email and never register an open.
- Apple Mail Privacy Protection, Gmail's image proxy, corporate security
  scanners and link-preview bots fetch images automatically. Those register opens
  that no human caused.
- Plain-text readers never load images at all.
- The pixel can only fire while the app is reachable at `APP_URL`.

So the UI calls the metric "opens", not "reads". Use it for relative comparison
between campaigns, not as evidence that a specific person read a specific email.

Previews and test sends **never** include the pixel, so they cannot pollute
statistics.

---

## Unsubscribes and the suppression list

Every campaign email carries an unsubscribe link built from a second 256-bit
random token, plus the standard headers for one-click unsubscribe:

```
List-Unsubscribe: <https://app/api/unsubscribe/TOKEN>, <mailto:unsubscribe@app>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

Place the link yourself with `{{unsubscribeUrl}}` anywhere in the body; if you
do not, a footer is appended automatically. There is no way to send without one.

Unsubscribing writes to a **global** `suppressions` table and immediately pulls
the address out of any queue it is sitting in. From then on:

- Recipient generation excludes suppressed addresses.
- The worker re-checks suppression at send time, so someone who unsubscribes
  mid-campaign is skipped (status `SUPPRESSED`, not `FAILED`).
- **Importing a CSV never re-subscribes anyone.** Suppressed addresses are
  skipped by the importer and reported in the import summary. Only an explicit
  removal on the Unsubscribed page can undo a suppression.

Reasons are `UNSUBSCRIBED` and `MANUAL` today; `HARD_BOUNCE` and `COMPLAINT`
already exist in the enum for when bounce processing is added. The worker treats
every reason identically, so adding one needs no worker change.

---

## Deployment

### Choosing a platform

The queue needs something to call `/api/worker/tick` roughly once a minute. That
requirement drives the whole decision.

| Platform | Verdict |
| --- | --- |
| **Docker on a small VPS / Fly.io / Railway / Render** | **Recommended.** Set `RUN_INTERNAL_WORKER=true` and the container ticks itself. No external scheduler, no plan restrictions. ~$5/month. |
| **Vercel Pro** | Works well. `vercel.json` already declares a `* * * * *` cron. Function duration is capped at 60s, which the worker respects. |
| **Vercel Hobby (free)** | **Not sufficient on its own.** Hobby cron jobs run **once per day**, which cannot drive an 83-emails-per-minute queue. See below. |
| **Any host + an external cron** | Works anywhere. Point cron-job.org, GitHub Actions, or a cron on another machine at the worker endpoint. |

The app is portable: the worker is a plain authenticated HTTP endpoint, so the
scheduler is a deployment choice, not an architectural one.

### Docker (recommended)

```bash
cp .env.example .env      # fill in ENCRYPTION_KEY, WORKER_SECRET, APP_URL
docker compose --profile app up --build -d
docker compose exec app node dist-scripts/create-admin.cjs you@example.com 'password'
```

The container applies migrations on boot and, with `RUN_INTERNAL_WORKER=true`,
runs its own ticker.

For a managed database instead of the bundled one, point `DATABASE_URL` at it and
start only the `app` service.

### Vercel

1. Import the repository and add a PostgreSQL database (Neon, Supabase, Vercel
   Postgres — anything with a connection string).
2. Set the environment variables from [below](#environment-variables). `APP_URL`
   must be your real public URL, or tracking pixels and unsubscribe links will
   point at localhost.
3. Run migrations once against the production database:
   `DATABASE_URL='postgres://…' npm run db:migrate`
4. Create the admin: `DATABASE_URL='postgres://…' npm run create-admin -- you@example.com 'password'`
5. `vercel.json` registers the cron. **On Hobby, replace it with an external
   scheduler** (below).

Use a pooled connection string if your provider offers one; the client already
sets `prepare: false` for pgbouncer compatibility.

### Driving the worker from an external scheduler

Any of these work; the endpoint is idempotent, so extra or overlapping calls are
harmless.

```bash
# cron-job.org, UptimeRobot, or any cron host — every minute
curl -X POST https://your-app.example.com/api/worker/tick \
     -H "Authorization: Bearer $WORKER_SECRET"
```

GitHub Actions (note: scheduled workflows have a 5-minute minimum and are
frequently delayed under load — fine for a slow campaign, poor for a
time-sensitive one):

```yaml
name: mailer-worker
on:
  schedule: [{ cron: "*/5 * * * *" }]
  workflow_dispatch:
jobs:
  tick:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -sS -X POST "${{ secrets.APP_URL }}/api/worker/tick" \
               -H "Authorization: Bearer ${{ secrets.WORKER_SECRET }}"
```

With a 5-minute interval, raise `WORKER_TICK_INTERVAL_SECONDS` to `300` so each
tick claims a proportionally larger batch, and check that the batch still fits
inside your platform's function timeout.

### Free-tier limitations, concretely

- **Vercel Hobby cron runs once per day.** Minute-level schedules require Pro.
  With a daily tick you would send one batch per day. Either upgrade, or use an
  external scheduler, or self-host.
- **Vercel function duration:** 60s is the practical Hobby ceiling.
  `WORKER_TIME_BUDGET_MS` defaults to 45s so a batch always finishes cleanly.
- **No background workers on serverless.** There is no always-on process; this is
  precisely why the design is "database + scheduled endpoint + short batches".
- **Free Postgres tiers** (Neon, Supabase) suspend on idle and cap connections.
  Keep `DATABASE_POOL_MAX` small (5 is the default).
- **Serverless cold starts** add latency to a tick but cost nothing in
  correctness — an interrupted tick just leaves rows queued for the next one.

---

## Architecture and trade-offs

**One Next.js app, one PostgreSQL database. No Redis, no queue broker, no
container orchestration.** For a private tool sending a few thousand emails an
hour, Postgres `SKIP LOCKED` *is* a perfectly good job queue, and it comes with
transactions and durability for free. Adding Redis or RabbitMQ would add
infrastructure to run, secure and pay for, without making a single guarantee
stronger.

Some specific choices:

- **Drizzle over Prisma.** No query engine binary, faster serverless cold starts,
  and it stays out of the way when a piece of logic needs hand-written SQL — which
  the queue does.
- **A hand-written CSV parser.** ~90 lines. Its exact behaviour around quoted
  delimiters, CRLF, BOMs and ragged rows is something the tests pin down
  directly, which matters more here than a dependency would.
- **A `contenteditable` editor rather than TipTap.** The required feature set
  (headings, bold/italic/underline, links, lists, alignment, undo/redo) maps
  one-to-one onto `document.execCommand`. That is ~150 lines against a
  multi-megabyte editor framework, and it emits plain HTML that email clients
  understand. Everything it produces is sanitized server-side. If rich tables or
  collaborative editing are ever needed, swapping in TipTap touches one component.
- **Delivery status and engagement are separate columns.** `delivery_status` is
  SMTP state; `first_opened_at` / `open_count` are engagement. Folding "opened"
  into the status enum would make "sent and opened" unrepresentable.
- **Recipients store a snapshot of the contact.** Historical statistics do not
  depend on the current contents of a list, and deleting a contact does not erase
  send history (`contact_id` becomes `NULL`; the email is kept).
- **`custom_fields` JSONB on contacts and recipients.** New personalization
  fields need no migration and no worker change — `buildMergeValues` picks them
  up automatically.

### Data model

```
users ── sessions
app_settings                     (single row; SMTP password encrypted at rest)

contacts ──< contact_list_members >── contact_lists
   │                                        │
   │                                  campaign_lists
   │                                        │
   └────────────< campaign_recipients >── campaigns
                        │
                  (snapshot + delivery state + tracking/unsubscribe tokens)

suppressions      (global, keyed by normalized email)
smtp_send_log     (one row per SMTP attempt; the rate limiter's input)
```

Indexed for the queries that matter: `contacts.email_normalized` (unique),
`campaign_recipients (campaign_id, delivery_status)`,
`(delivery_status, next_attempt_at)` for the claim query, unique indexes on both
tokens, and `UNIQUE(campaign_id, email_normalized)`.

---

## Environment variables

See `.env.example` for the annotated list. The essentials:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string. |
| `ENCRYPTION_KEY` | yes | 32 bytes (`openssl rand -hex 32`). Encrypts the stored SMTP password. Changing it means re-entering that password. |
| `WORKER_SECRET` | yes | Shared secret for `/api/worker/tick`. |
| `APP_URL` | production | Public base URL. Tracking pixels and unsubscribe links are built from it. |
| `SMTP_MAX_EMAILS_PER_HOUR` | no | Default `5000`. |
| `SMTP_RATE_SAFETY_FACTOR` | no | Default `0.95`. |
| `SMTP_MAX_ATTEMPTS` | no | Default `3`. |
| `WORKER_TIME_BUDGET_MS` | no | Default `45000`; stay under your platform's timeout. |
| `WORKER_BATCH_CAP` | no | Default `200` recipients per tick. |
| `WORKER_CONCURRENCY` | no | Default `4` parallel sends. |
| `WORKER_TICK_INTERVAL_SECONDS` | no | Default `60`. Match your actual cron interval. |
| `RUN_INTERNAL_WORKER` | no | `true` only for the Docker/VPS deployment. |
| `SMTP_*` | no | Override the stored settings entirely. Useful if you would rather keep credentials out of the database. **When set, the Settings page marks the affected fields as overridden**, so you are never editing a value that has no effect. |

Never commit real credentials. `.env` is gitignored; `.env.example` contains
placeholders only.

---

## Development

```bash
npm run dev          # dev server
npm run worker       # the ticker, in a second terminal
npm run lint
npm run typecheck
npm test
npm run build
npm run db:generate  # after editing src/lib/db/schema.ts
npm run db:migrate
```

### Tests

Tests run against a **real PostgreSQL database** (`mailer_test`, created
automatically on the same server as your dev database). The behaviour that
matters most — atomic claiming with `SKIP LOCKED`, `ON CONFLICT DO NOTHING`,
rolling-window counting — belongs to the database; mocking it would test the
mock rather than the guarantee. The worker tests additionally run a real
in-process SMTP server so retries and error classification are exercised against
actual SMTP replies.

Covered: CSV parsing, email normalization and validation, bulk-paste parsing,
duplicate removal, recipients on multiple lists, campaign recipient uniqueness,
rate-limit arithmetic, queue claiming under concurrency, lease recovery, retry
handling, suppressed recipients never being sent, open tracking, repeat opens
counting once, pause/resume/cancel, personalization, worker restart/resume,
credential redaction, HTML sanitization, and authentication on every endpoint.

---

## Security notes

- **Authentication** — single admin, scrypt-hashed password, opaque session
  tokens stored as SHA-256 hashes. Every admin page and API route requires a
  session; the only public endpoints are the tracking pixel and unsubscribe.
- **CSRF** — session cookies are `HttpOnly`, `SameSite=Lax`, `Secure` in
  production, and mutating endpoints additionally verify the `Origin` header.
  One-click unsubscribe is deliberately exempt (it is a public POST by design,
  authenticated by its token, and only ever removes consent).
- **SMTP credentials** — AES-256-GCM at rest, never serialized to the browser,
  and scrubbed out of every error message before it is logged or displayed.
- **HTML sanitization** — email bodies are sanitized on save with an allow-list
  (no scripts, event handlers, iframes, or `javascript:` URLs). Previews render
  inside a `sandbox=""` iframe.
- **Tokens** — 256 bits of CSPRNG output for tracking and unsubscribe URLs.
  Sequential database ids are never exposed.
- **SQL injection** — all queries are parameterized, both through Drizzle and in
  the hand-written SQL, which uses tagged templates.
- **Uploads** — 10 MB and 50,000-row ceilings, `.csv`/`.txt` only, decoded as
  UTF-8. CSV exports escape leading `=`/`+`/`-`/`@` to defuse spreadsheet formula
  injection.
- **Relay abuse** — no unauthenticated path can cause an email to be sent. Test
  sends and campaign queuing both require a session.

### Known advisory

`npm audit` reports a moderate advisory in `esbuild`, reached via
`drizzle-kit` → `@esbuild-kit/esm-loader`. It affects esbuild's development
server only, is a build-time dependency, and is not present in the production
image. It is fixable only by downgrading `drizzle-kit` to a version too old for
this schema.
