import Link from "next/link";
import { sql } from "@/lib/db";
import { queueSnapshot } from "@/lib/queue";
import { getSmtpConfig } from "@/lib/settings";
import { effectiveHourlyLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [totals] = await sql<Record<string, string>[]>`
    SELECT
      (SELECT count(*) FROM contacts)::text                                     AS contacts,
      (SELECT count(*) FROM contact_lists)::text                                AS lists,
      (SELECT count(*) FROM campaigns)::text                                    AS campaigns,
      (SELECT count(*) FROM suppressions)::text                                 AS suppressions,
      (SELECT count(*) FROM campaign_recipients
        WHERE delivery_status = 'SENT' AND sent_at > now() - interval '7 days')::text AS sent_7d,
      (SELECT count(*) FROM campaign_recipients WHERE delivery_status = 'SENT')::text AS sent_total,
      (SELECT count(*) FROM campaign_recipients
        WHERE delivery_status = 'SENT' AND first_opened_at IS NOT NULL)::text   AS opened_total
  `;

  const queue = await queueSnapshot();
  const config = await getSmtpConfig().catch(() => null);
  const maxPerHour = config?.maxEmailsPerHour ?? Number(process.env.SMTP_MAX_EMAILS_PER_HOUR ?? 5000);

  const sentTotal = Number(totals?.sent_total ?? 0);
  const openedTotal = Number(totals?.opened_total ?? 0);
  const openRate = sentTotal > 0 ? (openedTotal / sentTotal) * 100 : 0;

  const cards = [
    { label: "Contacts", value: totals?.contacts ?? "0", href: "/contacts" },
    { label: "Lists", value: totals?.lists ?? "0", href: "/lists" },
    { label: "Campaigns", value: totals?.campaigns ?? "0", href: "/campaigns" },
    { label: "Unsubscribed", value: totals?.suppressions ?? "0", href: "/suppressions" },
  ];

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <Link className="btn btn-primary" href="/campaigns/new">New campaign</Link>
      </div>

      {!config ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          SMTP is not configured yet. <Link className="underline" href="/settings">Set it up</Link> before sending.
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((card) => (
          <Link key={card.label} href={card.href} className="card px-4 py-3 transition hover:opacity-80">
            <p className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--color-muted)" }}>
              {card.label}
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{card.value}</p>
          </Link>
        ))}
      </div>

      <section className="grid gap-3 md:grid-cols-3">
        <div className="card px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--color-muted)" }}>
            Sent (last 7 days)
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{totals?.sent_7d ?? "0"}</p>
          <p className="hint mt-0.5">{sentTotal} sent all time</p>
        </div>
        <div className="card px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--color-muted)" }}>
            Current queue
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{queue.queued}</p>
          <p className="hint mt-0.5">
            {queue.sending} in flight · {queue.sentLastHour} of {effectiveHourlyLimit(maxPerHour)} used this hour
          </p>
        </div>
        <div className="card px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--color-muted)" }}>
            Open rate
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{openRate.toFixed(1)}%</p>
          <p className="hint mt-0.5">Opens are approximate — see a campaign for detail</p>
        </div>
      </section>

      <section className="card p-4">
        <h2 className="font-medium">Getting started</h2>
        <ol className="mt-2 grid gap-1 text-sm" style={{ color: "var(--color-muted)" }}>
          <li>1. Configure SMTP and send yourself a test message in <Link className="underline" href="/settings">Settings</Link>.</li>
          <li>2. Create a list and import contacts in <Link className="underline" href="/lists">Lists</Link>.</li>
          <li>3. Compose and queue a campaign in <Link className="underline" href="/campaigns">Campaigns</Link>.</li>
        </ol>
      </section>
    </div>
  );
}
