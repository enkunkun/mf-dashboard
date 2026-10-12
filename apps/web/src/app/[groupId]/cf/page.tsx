import { resolveCFTab } from "../../cf/cf-tab";
import { CFContent } from "../../cf/page";

export { metadata } from "../../cf/page";

export default async function GroupCFPage({ params, searchParams }: PageProps<"/[groupId]/cf">) {
  const [{ groupId }, { tab }] = await Promise.all([params, searchParams]);

  return <CFContent groupId={groupId} activeTab={resolveCFTab(tab)} />;
}
