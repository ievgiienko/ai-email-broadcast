"use client";

import { useState } from "react";

export default function UnsubscribeForm({ token, email }: { token: string; email: string }) {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const unsubscribe = async () => {
    setBusy(true);
    setError(false);
    try {
      const response = await fetch(`/api/unsubscribe/${encodeURIComponent(token)}`, { method: "POST" });
      if (!response.ok) throw new Error("failed");
      setDone(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <>
        <h1 className="text-lg font-semibold">You are unsubscribed</h1>
        <p className="hint mt-2"><strong>{email}</strong> will not receive further emails from us.</p>
      </>
    );
  }

  return (
    <>
      <h1 className="text-lg font-semibold">Unsubscribe</h1>
      <p className="mt-2 text-sm">
        Stop sending emails to <strong>{email}</strong>?
      </p>
      {error ? (
        <p className="mt-2 text-sm text-red-600">Something went wrong. Please try again.</p>
      ) : null}
      <button className="btn btn-primary mt-4" onClick={unsubscribe} disabled={busy}>
        {busy ? "Unsubscribing…" : "Yes, unsubscribe me"}
      </button>
    </>
  );
}
