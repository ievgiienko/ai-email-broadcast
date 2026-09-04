import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mailer",
  description: "Self-hosted email campaign manager",
};

/**
 * The theme is applied before paint to avoid a flash of the wrong colours.
 * It is a plain localStorage preference with a system-preference fallback.
 */
const THEME_SCRIPT = `
try {
  var stored = localStorage.getItem('theme');
  var dark = stored ? stored === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  if (dark) document.documentElement.classList.add('dark');
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
