import { ProjectDetail } from "@/components/project-detail";
import { getScope } from "@/lib/scope";

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string; to?: string }> }) {
  const { from, to } = await searchParams;
  return <ProjectDetail scope={await getScope()} id={(await params).id} from={from} to={to} />;
}
