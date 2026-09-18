import { INSTANCE, kvStoreStatus } from "../../lib/instance";
import type { WpProbe } from "./wp";

/**
 * Three independent clocks are baked into every page, and the matrix reads all
 * three:
 *   modifiedGmt  — did WordPress content change (the "version")
 *   upstreamDate — did the fetch actually reach WordPress (Data Cache signal)
 *   renderedAt   — did Next re-render the page (Full Route Cache signal)
 * plus instance, which says WHICH replica produced this HTML. On Atlas that
 * last one is the whole ballgame: the cache is per-replica, so two clients can
 * hold two different truths at the same instant.
 */
export function Probe({ route, wp }: { route: string; wp: WpProbe }) {
  const payload = {
    route,
    modifiedGmt: wp.modifiedGmt,
    postId: wp.databaseId,
    slug: wp.slug,
    upstreamDate: wp.upstreamDate,
    graphqlKeysHash: wp.graphqlKeysHash,
    fetchedAt: wp.fetchedAt,
    renderedAt: new Date().toISOString(),
    instance: INSTANCE,
    kv: kvStoreStatus(),
    error: wp.error,
  };
  return (
    <main>
      <h1>route {route}</h1>
      <pre id="probe">{JSON.stringify(payload, null, 2)}</pre>
    </main>
  );
}
