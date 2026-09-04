import { getPublicSettings } from "@/lib/settings";
import SettingsForm from "./SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  // Only the public projection crosses to the client — the stored SMTP password
  // is never serialized, only a boolean saying whether one exists.
  const settings = await getPublicSettings();
  return (
    <div className="grid gap-6">
      <h1 className="text-xl font-semibold">Settings</h1>
      <SettingsForm initial={settings} />
    </div>
  );
}
