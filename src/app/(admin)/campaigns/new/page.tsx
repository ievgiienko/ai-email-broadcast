import NewCampaignForm from "./NewCampaignForm";

export default function NewCampaignPage() {
  return (
    <div className="mx-auto grid max-w-lg gap-5">
      <h1 className="text-xl font-semibold">New campaign</h1>
      <NewCampaignForm />
    </div>
  );
}
