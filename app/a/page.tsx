import { Probe } from "../_lib/probe";
import { fetchProbe } from "../_lib/wp";

// The customer's shape: ISR page + a time-revalidated WPGraphQL POST.
// Purged by pages/api/revalidate (res.revalidate).
export const revalidate = 3600;

export default async function Page() {
  const wp = await fetchProbe("a", { next: { revalidate: 3600 } });
  return <Probe route="a" wp={wp} />;
}
