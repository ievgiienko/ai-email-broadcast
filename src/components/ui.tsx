"use client";

import { useCallback, useEffect, useState } from "react";

/* ------------------------------------------------------------------ fetch */

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** JSON fetch wrapper that surfaces the API's error message verbatim. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      // A full navigation, not a router push: the session is gone, so every
      // piece of cached client state should go with it.
      window.location.assign(new URL("/login", window.location.origin).href);
    }
    throw new ApiError(response.status, payload?.error ?? `Request failed (${response.status})`);
  }
  return payload as T;
}

/* --------------------------------------------------------------- feedback */

export function Alert({ kind, children }: { kind: "error" | "success" | "info"; children: React.ReactNode }) {
  const styles = {
    error: "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
    success:
      "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
    info: "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300",
  }[kind];
  return <div className={`rounded-lg border px-3 py-2 text-sm ${styles}`} role="status">{children}</div>;
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return <p className="text-sm" style={{ color: "var(--color-muted)" }}>{label}</p>;
}

export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="card px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-2 text-sm" style={{ color: "var(--color-muted)" }}>{children}</div> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- badges */

const STATUS_COLORS: Record<string, string> = {
  DRAFT: "text-zinc-600 dark:text-zinc-300",
  QUEUED: "text-amber-700 dark:text-amber-400",
  SENDING: "text-blue-700 dark:text-blue-400",
  COMPLETED: "text-emerald-700 dark:text-emerald-400",
  PAUSED: "text-orange-700 dark:text-orange-400",
  CANCELLED: "text-zinc-500 dark:text-zinc-400",
  SENT: "text-emerald-700 dark:text-emerald-400",
  FAILED: "text-red-700 dark:text-red-400",
  SUPPRESSED: "text-purple-700 dark:text-purple-400",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_COLORS[status] ?? ""}`}>{status}</span>;
}

/* ------------------------------------------------------------------ modal */

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="card w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-b-none sm:rounded-xl">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button className="btn px-2 py-1" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- formatting */

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/* ----------------------------------------------------------------- data */

export type Loader<T> = {
  data: T | null;
  error: string | null;
  /** Refetch, e.g. after a mutation. */
  reload: () => void;
  setError: (message: string | null) => void;
};

/**
 * Fetch-on-mount with stale-while-revalidating and unmount cancellation.
 *
 * The async work lives in a closure inside the effect so no state is set
 * synchronously during the effect body, and a late response from a superseded
 * request can never overwrite fresher data.
 *
 * `load` must be memoized by the caller (useCallback); its identity is the
 * dependency that drives refetching.
 */
export function useLoader<T>(load: () => Promise<T>): Loader<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await load();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Request failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data, error, reload, setError };
}

