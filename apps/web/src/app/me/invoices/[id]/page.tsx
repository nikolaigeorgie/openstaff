import { InvoiceDetail } from "@/components/invoice-detail";
import { getScope } from "@/lib/scope";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <InvoiceDetail scope={await getScope()} id={(await params).id} />;
}
