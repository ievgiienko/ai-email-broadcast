import ContactsTable from "@/components/ContactsTable";

export const dynamic = "force-dynamic";

export default function ContactsPage() {
  return (
    <div className="grid gap-5">
      <div>
        <h1 className="text-xl font-semibold">Contacts</h1>
        <p className="hint mt-1">
          Every contact you know, across all lists. Deleting here removes the contact from every list.
        </p>
      </div>
      <ContactsTable />
    </div>
  );
}
