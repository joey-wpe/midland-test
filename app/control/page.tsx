import { Probe } from "../_lib/probe";
import { fetchProbe } from "../_lib/wp";

// Never cached at any layer. Any staleness here is an infrastructure artifact,
// not a Next cache artifact — which makes this the edge-cache detector too.
export const dynamic = "force-dynamic";

export default async function Page() {
  const wp = await fetchProbe("control", { cache: "no-store" });
  return <Probe route="control" wp={wp} />;
}
