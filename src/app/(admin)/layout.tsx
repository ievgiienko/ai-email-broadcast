import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import Nav from "@/components/Nav";

/**
 * Every admin page is behind this layout's session check, so an unauthenticated
 * request never renders admin markup — the API routes enforce it independently.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  return (
    <>
      <Nav email={user.email} />
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </>
  );
}
