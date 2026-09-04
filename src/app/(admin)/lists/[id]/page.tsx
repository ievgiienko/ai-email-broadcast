import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contactLists } from "@/lib/db/schema";
import ListDetailClient from "./ListDetailClient";

export const dynamic = "force-dynamic";

export default async function ListDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rows = await db.select().from(contactLists).where(eq(contactLists.id, id)).limit(1);
  if (!rows[0]) notFound();

  return <ListDetailClient listId={id} name={rows[0].name} description={rows[0].description} />;
}
