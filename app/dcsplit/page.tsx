import { Probe } from "../_lib/probe";
import { fetchProbe } from "../_lib/wp";

/**
 * Reproduction for ticket 8617070 (whistleblowersattorneys.com).
 *
 * That ticket is hunting a stale cache "between the Node runtime and PHP",
 * on the strength of one observation: the page regenerated (x-nextjs-cache
 * STALE -> HIT) while serving pre-Aug-21 form data, and *no request reached
 * PHP* during the regeneration window. The inference is that something
 * intercepted the request. The inference does not hold — there is a
 * configuration that regenerates a page while issuing no upstream request at
 * all, and it lives inside the app.
 *
 * The Full Route Cache and the Data Cache are separate caches with separate
 * lifetimes. This route sets them deliberately apart:
 *
 *   route revalidate  20s        -> the page re-renders constantly
 *   fetch revalidate  1 year     -> the fetch is replayed from disk forever
 *
 * Every 20 seconds Next re-runs this component. `fetch` finds a live Data
 * Cache entry and returns it without touching the network. The page is
 * genuinely rebuilt, gets a new renderedAt, reports x-nextjs-cache HIT — and
 * contains data frozen at whenever that fetch entry was first written. No
 * packet leaves the process. WordPress logs nothing, because nothing was sent.
 *
 * `upstreamDate` is the proof. It is WordPress's own `date` response header,
 * stored in the fetch-cache entry and replayed verbatim on a hit. If
 * renderedAt advances while upstreamDate stays frozen, the render happened and
 * the fetch did not.
 *
 * Compare with /dcalign, which is identical except that the two lifetimes
 * match.
 */
export const revalidate = 20;

export default async function Page() {
  const wp = await fetchProbe("dcsplit", {
    // Effectively "never revalidate". `revalidate: false` would be clearer but
    // the customer's shape is a long finite TTL, so keep it finite.
    next: { revalidate: 31536000 },
  });
  return <Probe route="dcsplit" wp={wp} />;
}
