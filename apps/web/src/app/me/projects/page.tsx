import { ProjectsView } from "@/components/projects-view";
import { getScope } from "@/lib/scope";

export default async function Page({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const { from, to } = await searchParams;
  return <ProjectsView scope={await getScope()} from={from} to={to} />;
}
