import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import LoginForm from "./LoginForm";

export default async function LoginPage() {
  if (await getSessionUser()) redirect("/");
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="card w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold">✉ Mailer</h1>
        <p className="hint mt-1 mb-5">Sign in to manage your campaigns.</p>
        <LoginForm />
      </div>
    </main>
  );
}
