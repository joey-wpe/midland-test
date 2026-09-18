import { Probe } from "../_lib/probe";
import { fetchProbe } from "../_lib/wp";

// Statically rendered page whose fetch is explicitly uncached: there is a Full
// Route Cache entry but NO Data Cache entry. Isolates "did the page re-render"
// from "did the Data Cache get invalidated".
export const dynamic = "force-static";
export const revalidate = 3600;

export default async function Page() {
  const wp = await fetchProbe("e", { cache: "no-store" });
  return <Probe route="e" wp={wp} />;
}
