import { Probe } from "../_lib/probe";
import { fetchProbe } from "../_lib/wp";

/**
 * Control for /dcsplit. Identical in every respect except that the route and
 * fetch lifetimes agree.
 *
 * Without this arm, "/dcsplit never picks up new content" is ambiguous — it
 * could be the lifetime mismatch, or it could be something about this
 * environment, this backend, or Atlas generally. Running both against the same
 * WordPress change, in the same minutes, isolates the variable: same route
 * revalidate, same query, same everything, and only the fetch TTL differs.
 *
 * Expected: this one tracks the publish. /dcsplit does not.
 */
export const revalidate = 20;

export default async function Page() {
  const wp = await fetchProbe("dcalign", { next: { revalidate: 20 } });
  return <Probe route="dcalign" wp={wp} />;
}
