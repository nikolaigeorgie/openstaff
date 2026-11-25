import { InvoicesView } from "@/components/invoices-view";
import { getScope } from "@/lib/scope";

export default async function Page() {
  return <InvoicesView scope={await getScope()} />;
}
