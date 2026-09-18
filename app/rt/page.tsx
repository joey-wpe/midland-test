import { Probe } from "../_lib/probe";
import { fetchProbe } from "../_lib/wp";

// Tagged, and purged from an App Router Route Handler via revalidateTag.
// Also the probe for atlas-next's cache handler forwarding revalidateTag to
// the shared KV store — the dist source suggests it does not.
export const revalidate = 3600;

export default async function Page() {
  const wp = await fetchProbe("rt", { next: { revalidate: 3600, tags: ["rt-content"] } });
  return <Probe route="rt" wp={wp} />;
}
