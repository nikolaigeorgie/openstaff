import { invoiceCsv } from "@/components/invoice-detail";
import { getSession } from "@/lib/auth";
import { getScope } from "@/lib/scope";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getSession())) return new Response("Not signed in", { status: 401 });
  return invoiceCsv(await getScope(), (await params).id);
}
