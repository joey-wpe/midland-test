import { Probe } from "../_lib/probe";
import { fetchProbe } from "../_lib/wp";

// Tagged Data Cache entry. Target for revalidateTag from both routers.
export const revalidate = 3600;

export default async function Page() {
  const wp = await fetchProbe("c", { next: { revalidate: 3600, tags: ["content"] } });
  return <Probe route="c" wp={wp} />;
}
