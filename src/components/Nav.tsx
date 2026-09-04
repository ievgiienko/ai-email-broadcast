"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/contacts", label: "Contacts" },
  { href: "/lists", label: "Lists" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/suppressions", label: "Unsubscribed" },
  { href: "/settings", label: "Settings" },
];

export default function Nav({ email }: { email: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  /**
   * The theme lives on <html>, not in React state: reading it during render
   * would mismatch the server, and the icon can be swapped with CSS instead.
   */
  const toggleTheme = () => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      // Private browsing; the choice just won't persist.
    }
  };

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <header className="sticky top-0 z-40 border-b" style={{ backgroundColor: "var(--color-surface)" }}>
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
        <Link href="/" className="font-semibold tracking-tight">✉ Mailer</Link>

        <nav className="ml-4 hidden gap-1 md:flex">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`nav-link ${isActive(link.href) ? "nav-link-active" : ""}`}
              aria-current={isActive(link.href) ? "page" : undefined}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <button className="btn px-2 py-1 text-xs" onClick={toggleTheme}
            title="Toggle light/dark" aria-label="Toggle theme">
            <span className="theme-icon-light">☾</span>
            <span className="theme-icon-dark">☀</span>
          </button>
          <span className="hidden text-xs sm:inline" style={{ color: "var(--color-muted)" }}>{email}</span>
          <button
            className="btn px-2 py-1 text-xs"
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              router.push("/login");
              router.refresh();
            }}
          >
            Sign out
          </button>
          <button className="btn px-2 py-1 text-xs md:hidden" onClick={() => setOpen((o) => !o)}
            aria-expanded={open} aria-label="Menu">☰</button>
        </div>
      </div>

      {open ? (
        <nav className="grid gap-1 border-t px-4 py-2 md:hidden">
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} onClick={() => setOpen(false)}
              className={`nav-link py-2 ${isActive(link.href) ? "nav-link-active" : ""}`}
              aria-current={isActive(link.href) ? "page" : undefined}>
              {link.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
