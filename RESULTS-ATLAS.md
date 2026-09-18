# Atlas run results

Run date: 2026-09-18.
Environment: `h1zqz5eo211ukydaab4lzvbse.js.wpenginepowered.com`, build `74493237-faf3-b3b7-0f8f-10a122072baa`.
Backend: `headlessblogw1.wpenginepowered.com` (WPGraphQL, POST).
Raw data: `results/atlas-raw.json`, `results/atlas-combined.json`.

---

## 1. Headline

On Atlas, `res.revalidate()` from `pages/api` **does** refresh an App Router
route's origin cache — matching the local result, in ~145ms. But **the Atlas
edge is not purged by any revalidation mechanism**, and it fronts pages with
`s-maxage=3600, stale-while-revalidate=31532400`. Fresh content sat at the
origin while real visitors kept getting a version up to an hour old.

**Revalidation alone is not enough on Atlas. It must be paired with an explicit
edge purge, in that order.** That combination refreshed both layers in 302ms.

## 2. The matrix

`origin` = sampled with a unique query string, bypassing Cloudflare, reading
Next's own cache. `edge` = a plain GET, i.e. what a visitor gets. Window 75s.

| Cell | Mechanism | Purge | Origin fresh | Edge fresh |
|---|---|---|---|---|
| `res-revalidate` | `res.revalidate('/a')` from `pages/api` | ok | **145ms** | **never** |
| `pages-revalidate-path` | `revalidatePath` from `pages/api` | **threw E263** | never | never |
| `app-revalidate-path` | `revalidatePath` from a Route Handler | ok | **480ms** | **never** |
| `app-revalidate-tag` | `revalidateTag` from a Route Handler | ok | **529ms** | **never** |
| `edge-purge` | `purgePaths` alone | ok | never | never |
| `revalidate-then-purge` | `res.revalidate` **then** `purgePaths` | ok | **302ms** | **302ms** |

Every cell verified `still stale: true` before purging, so each one measured a
real invalidation rather than a cache that had already lapsed.

## 3. Findings

### 3.1 The edge is the actual problem, not the Data Cache

The customer's dev asked whether `res.revalidate()` invalidates the Data Cache.
It does — locally and on Atlas. But that question turns out not to be the one
that decides whether their architecture works.

Pages are served with `cache-control: s-maxage=3600, stale-while-revalidate=31532400`.
A direct measurement mid-run: the edge served `modified=15:02:58` with `age=553`
while the origin already had `15:06:13`. **Nine minutes stale, and it would have
stayed stale for up to an hour.**

This confirms at runtime what `../atlas-revalidate-test/RESULTS.md` §11c finding 4
predicted from source: the cache handler's post-revalidation edge purge is gated
on `CachedRouteKind.PAGES`, so App Router routes never trigger it. This is the
most likely concrete meaning of "on-demand ISR is supported only in the context
of the traditional Pages Router" — the revalidation is not dropped, the *edge
invalidation step* is skipped.

### 3.2 Ordering is load-bearing

`purgePaths` **alone accomplishes nothing** (`edge-purge` cell: origin never went
fresh, edge never went fresh). Purging the edge while the origin is still stale
just makes the edge re-fetch and re-cache the same stale HTML.

The working sequence is **revalidate first, then purge**:

```
POST /api/revalidate?path=/a        →  origin now fresh
POST  purgePaths(['/a'])            →  edge drops its copy, re-pulls fresh
```

Reversed or used alone, it silently fails while every call still returns HTTP 200.

### 3.3 `revalidatePath` / `revalidateTag` work from an App Router Route Handler

This settles the question `RESULTS.md` §8 left open, and in the direction I
declined to assert without evidence.

- from `pages/api`: throws `E263 Invariant: static generation store missing` — on Atlas, same as locally
- from `app/api/.../route.ts`: **`ok: true`, origin fresh in 480ms / 529ms**

So E263 is an artifact of calling those functions where no App Router work store
exists. It is not an Atlas limitation and not a Next.js limitation.

**This has a direct consequence for the recommendation.** The `pages/api`
endpoint was proposed to work around `revalidatePath` being unavailable. On this
evidence the customer does not need it — an App Router Route Handler does the
same job natively, with `revalidateTag` available too, which `res.revalidate`
cannot offer. The Pages Router endpoint remains a valid option; it is no longer
the only one.

Caveat: single replica. `revalidateTag` not propagating across replicas
(§11c finding 3) is untested and unaffected by this result.

### 3.4 The KV store env vars *are* present — correcting the record again

`/api/whoami` reports from inside the running container:

```json
{"kvUrlPresent": true, "kvTokenPresent": true, "rolloutPercent": null,
 "buildId": "74493237-faf3-b3b7-0f8f-10a122072baa"}
```

Both `HEADLESS_KV_STORE_URL` and `HEADLESS_KV_STORE_TOKEN` are set on this
environment. `rolloutPercent` unset means the default of 100 applies, so
`useKVStore()` returns true for every cache key and the remote cache handler
path is live — not dormant.

This does not square with "there is no shared KV store, confirmed by
engineering," and I want to be careful about what it does and doesn't show.
It shows the **env vars are provisioned and the code path is reachable**. It
does **not** show that the store is shared across replicas, because this
environment only ever presented one replica — there was nothing to share with.
Both statements can be true if the store is per-environment rather than
cross-replica, or if it is provisioned but unused for App Router entries (which
are written with an empty `nextRevalidateMethod`, consistent with the
Pages-Router-only theory).

Worth putting back to engineering as a specific question rather than a general
one: *these two env vars are set on this environment — what backs them, and is
that storage shared between replicas of the same environment?*

### 3.5 `x-nextjs-cache` is still not a freshness signal

Busted requests to a route that had just been revalidated returned
`x-nextjs-cache: HIT` while serving freshly regenerated content, and plain
requests returned `REVALIDATED` while serving a nine-minute-old copy from
Cloudflare. Matches the local finding. Do not diagnose with this header.

## 4. What this run could NOT answer

**The replica divergence question — the reason this app was built — is still
open.** Thirty consecutive `/api/whoami` calls returned the same pod
(`...-6d89758f87-c8nkt`, pid 17). One replica.

With a single replica there is nothing to diverge, so `diverged=false` on every
cell is a **property of the test environment, not a finding about Atlas.** It
must not be read as "cache state is consistent across replicas."

To answer it, the environment needs to be scaled to more than one instance —
then re-run `node scripts/run-atlas-matrix.mjs` unchanged and read
`everDiverged` and `allFreshMs`. The harness is built for it; it just needs a
fleet to measure.

## 5. Recommendation

On this evidence, for an App Router route on Atlas:

1. **Revalidate, then purge the edge.** Either mechanism alone leaves visitors
   on stale content. Both, in order, refresh everything in ~300ms.
2. **An App Router Route Handler is sufficient** for the revalidation step —
   the `pages/api` endpoint is optional, not required (§3.3).
3. **Do not rely on `x-nextjs-cache`** when debugging this with the customer.
4. **Do not extrapolate any of this to a multi-replica environment** until §4 is
   resolved. If the ISR store is per-replica, revalidation fixes one instance
   and the edge purge then has a chance of re-caching stale content pulled from
   a different, still-stale replica. That failure mode would be intermittent and
   would look exactly like a flaky CDN.

Item 4 is the one I would put to the Headless Platform team first, together with
the §3.4 question.

## 6. Scope limits

- Single replica; see §4.
- Next 16.3.5, `cacheComponents` off. Confirm the customer's version before
  relaying — the writeup assumes 16.3.
- `@wpengine/edge-cache` is rate limited (~300 ops/hour). A high-frequency
  publisher could exhaust that; not tested here.
- Convergence windows were 60–75s. "Never" means "not within the window," and
  the edge's `s-maxage=3600` implies up to an hour, but that was not waited out.
- The WordPress side used a REST excerpt bump as the publish trigger. A real
  `save_post` hook may differ in timing, though the GraphQL read reflected the
  change within 3s.
