import { resolveCFTab } from "../../cf/cf-tab";
import { CFContent } from "../../cf/page";

export { metadata } from "../../cf/page";

export default async function GroupCFPage({ params, searchParams }: PageProps<"/[groupId]/cf">) {
  const { groupId } = await params;

  if (process.env.DEMO_MODE === "true") {
    return <CFContent groupId={groupId} includeBothTabs />;
  }

  const { tab } = await searchParams;

  return <CFContent groupId={groupId} activeTab={resolveCFTab(tab)} />;
}
