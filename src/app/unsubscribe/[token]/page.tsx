import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaignRecipients, suppressions } from "@/lib/db/schema";
import UnsubscribeForm from "./UnsubscribeForm";

export const dynamic = "force-dynamic";

/**
 * Public unsubscribe page. Requires no login: the token in the URL is the
 * credential. It only ever reveals the address the token already identifies.
 */
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const rows = await db
    .select({
      email: campaignRecipients.email,
      emailNormalized: campaignRecipients.emailNormalized,
    })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.unsubscribeToken, token))
    .limit(1);

  const recipient = rows[0];
  const already = recipient
    ? (await db
        .select({ id: suppressions.id })
        .from(suppressions)
        .where(eq(suppressions.emailNormalized, recipient.emailNormalized))
        .limit(1)).length > 0
    : false;

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="card w-full max-w-md p-6 text-center">
        {!recipient ? (
          <>
            <h1 className="text-lg font-semibold">Link not recognised</h1>
            <p className="hint mt-2">
              This unsubscribe link is invalid or has expired. If you keep receiving mail you did not ask
              for, reply to one of the messages and we will remove you.
            </p>
          </>
        ) : already ? (
          <>
            <h1 className="text-lg font-semibold">You are unsubscribed</h1>
            <p className="hint mt-2">
              <strong>{recipient.email}</strong> will not receive further emails from us.
            </p>
          </>
        ) : (
          <UnsubscribeForm token={token} email={recipient.email} />
        )}
      </div>
    </main>
  );
}
