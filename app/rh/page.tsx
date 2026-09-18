import { Probe } from "../_lib/probe";
import { fetchProbe } from "../_lib/wp";

// Same shape as /a, but purged from an App Router Route Handler via
// revalidatePath. RESULTS.md §8 left open whether that works where a
// pages/api handler threw E263 (no work store). This route settles it.
export const revalidate = 3600;

export default async function Page() {
  const wp = await fetchProbe("rh", { next: { revalidate: 3600 } });
  return <Probe route="rh" wp={wp} />;
}
