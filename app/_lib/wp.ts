export const WP_GRAPHQL =
  process.env.WP_GRAPHQL_URL ?? "https://headlessblogw1.wpenginepowered.com/graphql";

export type WpProbe = {
  /** Post modification time. This is the "version" signal: it moves when the
   *  customer publishes. There is no mock origin on Atlas, so WordPress's own
   *  data has to carry the freshness marker. */
  modifiedGmt: string | null;
  title: string | null;
  slug: string | null;
  databaseId: number | null;
  /** WordPress's `date` response header. Next stores response headers in the
   *  fetch-cache entry and replays them verbatim on a hit, so a *frozen*
   *  upstreamDate across two renders proves the Data Cache served the fetch,
   *  and a moving one proves the fetch actually left the Node process. This is
   *  the Atlas stand-in for the local harness's authoritative hit counter. */
  upstreamDate: string | null;
  /** WPGraphQL Smart Cache key header — handy for correlating with WP-side purges. */
  graphqlKeysHash: string | null;
  fetchedAt: string;
  error: string | null;
};

/**
 * Every route must produce a DISTINCT Data Cache entry, or one route's purge
 * silently invalidates another's and the matrix reads as a false positive.
 * For POST fetches the cache key includes the body, so varying the GraphQL
 * operation name per route is enough — and unlike a dummy variable it stays
 * valid GraphQL (unused variable declarations fail validation).
 */
function query(routeKey: string) {
  const op = `Probe_${routeKey.replace(/[^A-Za-z0-9_]/g, "_")}`;
  return `query ${op} {
  generalSettings { title }
  posts(first: 1, where: { orderby: { field: MODIFIED, order: DESC } }) {
    nodes { databaseId slug title modifiedGmt }
  }
}`;
}

export async function fetchProbe(
  routeKey: string,
  init: RequestInit & { next?: { revalidate?: number | false; tags?: string[] } } = {}
): Promise<WpProbe> {
  const fetchedAt = new Date().toISOString();
  try {
    const res = await fetch(WP_GRAPHQL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: query(routeKey) }),
      ...init,
    });
    const json = await res.json();
    const node = json?.data?.posts?.nodes?.[0] ?? null;
    return {
      modifiedGmt: node?.modifiedGmt ?? null,
      title: node?.title ?? null,
      slug: node?.slug ?? null,
      databaseId: node?.databaseId ?? null,
      upstreamDate: res.headers.get("date"),
      // WPGraphQL Smart Cache emits `x-graphql-keys` (the earlier
      // `x-graphql-keys-hash` guess was simply the wrong header name, which is
      // why this read null on every sample in the first Atlas run).
      graphqlKeysHash:
        res.headers.get("x-graphql-keys") ?? res.headers.get("etag"),
      fetchedAt,
      error: json?.errors ? JSON.stringify(json.errors).slice(0, 300) : null,
    };
  } catch (err) {
    return {
      modifiedGmt: null,
      title: null,
      slug: null,
      databaseId: null,
      upstreamDate: null,
      graphqlKeysHash: null,
      fetchedAt,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}
