# atlas-revalidate-wpe

Headless WordPress test app for the WP Engine Headless Platform (Atlas).

Backend: `https://headlessblogw1.wpenginepowered.com/graphql` (WPGraphQL, POST).

## Why this exists

The local harness (`../atlas-revalidate-test`) answered the customer's literal
question — on vanilla Next 16.3.5, `res.revalidate()` from a `pages/api` route
**does** invalidate both the Full Route Cache and the App Router Data Cache for
that path. Proven at the filesystem level.

That result has a structural limit, recorded in that repo's `RESULTS.md` §9:
a single `next start` on a laptop is one process with one cache. Atlas runs
several Node replicas behind a load balancer and the cache is not shared across
them. `res.revalidate()` lands on whichever replica the load balancer picked;
the others keep serving what they had. The customer experiences that as
intermittent staleness that looks random and is nearly impossible to reproduce
on request.

**A single-process test cannot surface that failure mode.** This app exists to
surface it on real infrastructure.

## What changed versus the local harness

| Local | Here |
| --- | --- |
| Mock origin on :4000 with an authoritative hit counter | Real WPGraphQL; freshness is carried by a post's `modifiedGmt` |
| "Did the fetch leave Next" read from the counter | Read from WordPress's `date` response header, which Next stores in the fetch-cache entry and replays on a hit |
| GET `/content` | POST `/graphql` — the customer's actual fetch shape |
| Harness restored a pristine `.next` between cells | Impossible remotely; every cell owns a distinct route instead |
| One process, one cache | N replicas; every page and every endpoint stamps **which replica** answered |

## Signals baked into every page

Each route renders `<pre id="probe">` with:

- `modifiedGmt` — the content version. Moves when someone publishes.
- `upstreamDate` — WordPress's `date` header. **Frozen** across renders means
  the Data Cache served the fetch; **moving** means the fetch really left Node.
- `renderedAt` — moves when the page re-renders (Full Route Cache signal).
- `instance` — the replica that **rendered** this HTML (`id`, `host`, `pid`, `bootedAt`).
- `kv` — whether atlas-next's shared KV store is wired up in this environment.

`/api/whoami` reports the replica that **served** the request. Hammering it
counts the fleet; comparing that count against the distinct `instance` values
embedded in cached pages is the divergence measurement.

## Routes

| Route | Shape | Purged by |
| --- | --- | --- |
| `/a` | `revalidate=3600` + `next.revalidate=3600` — the customer's shape | `pages/api/revalidate` (`res.revalidate`) |
| `/c` | as `/a`, fetch tagged `content` | `pages/api/revalidate-tag`, `pages/api/revalidate-path` |
| `/e` | `force-static` + `cache:'no-store'` — route cached, **no** Data Cache entry | `pages/api/purge-edge` |
| `/rh` | as `/a` | `app/api/app-revalidate-path` (Route Handler) |
| `/rt` | as `/a`, fetch tagged `rt-content` | `app/api/app-revalidate-tag` (Route Handler) |
| `/control` | `force-dynamic` + `no-store` | never cached; the reference clock |

Every route issues a **distinct GraphQL operation name**, so every route gets
its own Data Cache entry. This is not cosmetic: in the local harness three
routes sharing one URL collapsed into one shared cache entry and a tag silently
failed to attach, which would have produced a confident wrong answer. Verified
here — four cached fetches, four entries, tags on the correct two.

## Open questions this app is built to answer

1. **How bad is replica divergence?** Not *whether* — engineering has confirmed
   there is no shared cache store for App Router, so divergence is the expected
   behaviour, not a hypothesis. What's unknown is severity: how many replicas,
   what fraction stays stale after a purge, and how long until natural TTL
   expiry closes the gap. Measured by `everDiverged`, `firstFreshMs` and
   `allFreshMs` per cell.
2. **Does `revalidatePath`/`revalidateTag` work from an App Router Route
   Handler?** Locally it threw `E263` from `pages/api` (no work store) and
   returned `ok:true` from a Route Handler. Whether Atlas's cache handler
   honours it is untested — and `RESULTS.md` §8 deliberately stops short of
   claiming the WP Engine doc's "not compatible" is about upstream Next.
3. **Does App Router on-demand revalidation purge the edge?** Reading
   atlas-next's dist source, the post-revalidation edge purge fires only for
   `CachedRouteKind.PAGES`. If that holds, App Router writes fresh content into
   the ISR store and the edge keeps serving stale — making `@wpengine/edge-cache`
   mandatory rather than an optimisation.
4. **Confirming there is no shared store.** WP Engine engineering has confirmed
   there is no shared KV cache available for App Router; the `kvStore` client in
   atlas-next's dist is gated on `HEADLESS_KV_STORE_URL` / `..._TOKEN` and its
   on-demand semantics are Pages-Router-only (empty `nextRevalidateMethod` for
   App Router entries, `isODISR` gated on `CachedRouteKind.PAGES`,
   `revalidateTag` never calling KV at all). The `kv` block in every probe
   reports those env vars so the run **evidences** that rather than assuming it.
   This is a confirmation check, not an open variable.

## Running it

Deploy to Atlas, set env vars in the Atlas UI (`REVALIDATE_SECRET`,
`WP_GRAPHQL_URL`), then:

```bash
BASE=https://<your-env>.wpenginepowered.com \
SECRET=<REVALIDATE_SECRET> \
WP_USER=<wp user> WP_APP_PASSWORD='<app password>' \
node scripts/run-atlas-matrix.mjs
```

Each cell: baseline → publish → confirm still stale → purge → poll until the
whole fleet converges or the window expires. `SAMPLES` (default 12) is samples
per round, `WINDOW` (default 90) the seconds to keep polling, `ONLY` restricts
cells, `OUT` sets the output path.

Without `WP_USER`/`WP_APP_PASSWORD` the runner pauses for a manual edit in
wp-admin. An Application Password (wp-admin → Users → Profile) makes the run
unattended, which matters because each cell needs its own publish.

### Reading the output

- `stale-before=false` means the cache did not hold the old version long enough
  and **the cell proved nothing** — not that revalidation worked.
- `diverged=true` in any round means two content versions were alive
  simultaneously. That is the finding.
- `all-fresh=NEVER` means at least one replica never picked up the change
  within the window.

## Caveats

- Run against a **non-production** Atlas environment. The matrix publishes to
  WordPress and purges caches repeatedly.
- `@wpengine/edge-cache` is a silent no-op off-platform: the local smoke test
  returns `ok:true` with an undefined result. Only the Atlas run is meaningful.
- `@wpengine/edge-cache` is rate limited (~300 ops/hour, 30 tags per call).
  Keep `SAMPLES`/`WINDOW` modest while iterating.
- Cache Components stays **off**. Turning it on removes the `revalidate` and
  `dynamic` segment configs the whole harness depends on.
- Replica count is inferred from observed distinct instances, so it is a lower
  bound. A quiet environment may be scaled to one, in which case the primary
  question cannot be answered — check `discover.replicasObserved > 1` before
  trusting a clean result.
