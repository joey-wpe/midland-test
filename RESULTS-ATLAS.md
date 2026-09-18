# Atlas run results

Run date: 2026-09-18 (two passes: single-replica, then scaled to 7).
Environment: `h1zqz5eo211ukydaab4lzvbse.js.wpenginepowered.com`
(builds `74493237-...` single-replica, `559e3268-...` scaled).
Backend: `headlessblogw1.wpenginepowered.com` (WPGraphQL, POST).
Raw data: `results/atlas-raw.json`, `results/atlas-combined.json`,
`results/atlas-multireplica.json`.

---

## 1. Headline

On Atlas, `res.revalidate()` from `pages/api` **does** refresh an App Router
route's origin cache — matching the local result, in ~145ms. But **the Atlas
edge is not purged by any revalidation mechanism**, and it fronts pages with
`s-maxage=3600, stale-while-revalidate=31532400`. Fresh content sat at the
origin while real visitors kept getting a version up to an hour old.

**Revalidation alone is not enough on Atlas. It must be paired with an explicit
edge purge, in that order.** That combination refreshed both layers in 302ms.

Separately, and contrary to the assumption this app was built on: **the ISR
store IS shared across replicas** on this environment. Scaled to 7 pods, a
purge on one pod updated what all seven served, in under a second. See §4.

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

~~Caveat: `revalidateTag` cross-replica propagation is still untested.~~
**Resolved — see §4b. Tags propagate across the fleet, as fast as paths.**

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
engineering." When written, this section could only show that the env vars were
provisioned and the code path reachable — not that anything was actually shared,
since only one replica existed.

**§4 closes that gap: the store is demonstrably shared across replicas.** Pods
serve renders produced by other pods, which is only possible via shared storage.
So the KV path is not merely reachable, it is doing real work.

The question for engineering is therefore narrower and more useful than "is
there a shared store": *these vars are provisioned on this environment and the
store is observably shared — which environments get one, what backs it, and
what determines whether a given customer environment has it?*

### 3.5 `x-nextjs-cache` is still not a freshness signal

Busted requests to a route that had just been revalidated returned
`x-nextjs-cache: HIT` while serving freshly regenerated content, and plain
requests returned `REVALIDATED` while serving a nine-minute-old copy from
Cloudflare. Matches the local finding. Do not diagnose with this header.

### 3.6 `purgeTags` works, and it discriminates by tag

Run: build `1ce79ef4`+ (revision `00010`). Raw: `results/edge-tag-purge.json`.
Script: `scripts/run-edge-tag-purge.mjs`. Cost: 2 purge operations.

§3.2 showed the edge can only be fixed by an explicit purge, but `purgePaths`
is the wrong ergonomics for the customer: a `save_post` hook knows a post ID,
not which routes render it, so it forces a post-ID-to-paths map maintained in
PHP and kept in sync with Next routing by hand. `purgeTags` removes that.

Routes are tagged via `next.config.ts` `headers()` — `/a`, `/c`, `/e`, `/rh`,
`/rt` each carry `Cache-Tag: post-3267,route-<x>`.

| Arm | Call | Expected fresh | Expected untouched | Result |
|---|---|---|---|---|
| `narrow` | `purgeTags(['route-a'])` | `/a` | `/c`, `/rt` | `/a` fresh at **2475ms**, controls untouched |
| `broad` | `purgeTags(['post-3267'])` | `/a`,`/c`,`/rh`,`/rt` | — | **all four fresh at 221ms, one call** |

Both arms confirmed origin-fresh and edge-stale immediately before purging, so
neither measured an incidental expiry.

**The narrow arm is the load-bearing one.** Cloudflare strips `Cache-Tag`
before the response reaches a client, so there is no way to read the header
back and confirm it landed — and a broad purge alone cannot distinguish "the
tag purge worked" from "something purged everything." Untouched routes staying
stale is the only observation that proves the edge honours these specific tags.

It held, and the delayed check is stronger than the in-loop one. Twenty seconds
after the `route-a` purge, `/c` and `/rt` were still serving `16:25:27` — a
version from the *previous* test run — while their origins had been revalidated
to `16:29:25` and `/a`'s edge had refreshed to it:

```
/a   edge 2026-09-18T16:29:25   (purged by tag)
/c   edge 2026-09-18T16:25:27   origin was 16:29:25   (not purged)
/rt  edge 2026-09-18T16:25:27   origin was 16:29:25   (not purged)
```

That single table is also the cleanest restatement of §3.1: three routes, all
fresh at the origin, and only the tagged one reached a visitor.

**What this means for the customer.** One `purgeTags(['post-3267'])` from a
`save_post` hook invalidates every route rendering that post, with no route map
in PHP. Under the hourly cap this is also the economical shape — batching many
tags into one call is one operation regardless of tag count (30 tags/call,
~300 operations/hour/environment).

Ordering from §3.2 still applies unchanged: **revalidate the origin first, then
purge.** Nothing about tags relaxes that.

## 4. Replica divergence — ANSWERED, and not the way we expected

The first pass ran on a single replica and could not test this. A second pass
forced the environment to scale out, and the result reverses the working
assumption.

**The ISR store IS shared across replicas on this environment.**

### How the fleet was scaled

Atlas autoscales on in-flight concurrency, not request count, so volume alone
does nothing — cached pages return in milliseconds and never hold a connection.
Holding 40 concurrent requests against `/api/load` (a sleep endpoint added for
exactly this, so WordPress takes no load) scaled the environment from 1 to
**7 pods**, which stayed up for the duration of the run.

### The evidence

Every page embeds the instance that *rendered* it. If a pod serves HTML stamped
with a different pod's ID, it did not produce that HTML — it read it from
somewhere shared.

| Cell | Purge landed on | Renderers seen across 20 concurrent samples |
|---|---|---|
| baseline (before any purge) | — | **6 distinct** — each pod had its own copy |
| `res-revalidate` | `3f1844a9` | **1: `3f1844a9`** |
| `app-revalidate-path` | `758d906b` | +0s: 2 (`3f1844a9`, `758d906b`) → +6s: **1: `758d906b`** |
| `revalidate-then-purge` | `979a3828` | **1: `979a3828`** |

The baseline is the control and it matters: before any purge, 20 samples of the
same route returned **six different renderers**, proving the load balancer really
does spread requests and the harness can tell the pods apart. After a purge,
those same 20 samples all returned the render produced by *the single pod that
handled the purge call*. Five other pods served a render they never performed.

A dedicated propagation measurement (publish → `res.revalidate` → 10 concurrent
cache-busted samples every 400ms) found the fleet fully consistent on the
**first sample at +950ms**, all ten showing the purging pod's render.

### What this means

- `res.revalidate()` on one replica **does** update what every other replica
  serves, within roughly a second.
- This contradicts the premise the harness was built around ("the cache is not
  persistent through other replicas") and the "no shared KV store" answer from
  engineering. It is consistent with §3.4: `HEADLESS_KV_STORE_URL` and
  `HEADLESS_KV_STORE_TOKEN` are provisioned here and `rolloutPercent` is unset,
  so the remote cache handler runs at 100%.
- The `app-revalidate-path` cell caught a genuine but brief inconsistency
  window: two versions alive simultaneously at +0s, resolved by +6s. So
  divergence exists, but as a sub-second-to-few-second propagation window, not
  as the indefinite per-replica staleness that was feared.

### Scope — read before relaying

This is one environment, observed on one day, with the KV env vars present. It
does **not** establish that every Atlas environment behaves this way; an
environment without those vars provisioned would fall through to the per-replica
filesystem cache and the original concern would apply in full. The right
question for the platform team is no longer "is there a shared store" but
**"which environments get one, and what determines that."**

## 4b. `revalidateTag` across replicas — it propagates

Run: build `1ce79ef4` (revision `00009`), 7 pods, 16 concurrent cache-busted
samples per round at 600ms. Raw: `results/tag-propagation.json`.
Script: `scripts/run-tag-propagation.mjs`.

§4 proved the *page* store is shared but left tags open, because the handler's
`revalidateTag` delegates only to the local filesystem cache — a different code
path, and only ever exercised single-replica. It mattered: tag invalidation is
the granular mechanism the AUSL recommendation builds an external Redis key
namespace to obtain.

### Method changes that make this conclusive

1. **`x-serving-instance`** (`middleware.ts`, Node runtime). §4 *inferred*
   sharing from rendering-pod IDs collapsing to one. The serving pod is now
   named outright, so "pod B returned pod A's render" is read off a single
   sample.
2. **A control arm.** `/rh` purged with `revalidatePath` on the same fleet,
   seconds later. Same storage, same LB, same pods — so any difference is
   attributable to the tag path and nothing else.

### Result

| Arm | Mechanism | Purge pod | Still stale first | First fresh | First fresh **on another pod** | All 16 fresh |
|---|---|---|---|---|---|---|
| `tag` | `revalidateTag('rt-content')` | `71d49079` | yes (0/16) | 699ms | **1433ms** | **1433ms** |
| `path` | `revalidatePath('/rh')` (control) | `5c238786` | yes (0/16) | 835ms | 1569ms | 1569ms |

**Tags propagate, and if anything slightly faster than paths.** The gap is
within run-to-run noise; the finding is that they are equivalent, not that tags
are quicker.

The direct evidence, from the final tag round — four different serving pods
returning a render produced by the purging pod, at the *same millisecond*:

```
served by 5c238786 | rendered by 71d49079 | renderedAt 16:25:20.456Z
served by eeb0fb1c | rendered by 71d49079 | renderedAt 16:25:20.456Z
served by 2ec6bd0a | rendered by 71d49079 | renderedAt 16:25:20.456Z
served by 02dbc410 | rendered by 71d49079 | renderedAt 16:25:20.456Z
```

One render event, read by the whole fleet. Six distinct non-purging pods served
the fresh version.

### The baseline is a finding in its own right

Before either purge: **6 distinct rendering pods, and `crossPodServes` 0/16.**
Every pod served a render it had performed itself.

So sharing is not "all pods always read one entry." On the initial cold fill
each pod renders and keeps its own copy; the shared store asserts itself *after
an invalidation*, when the fleet converges on one regenerated entry. That
distinction matters when relaying this — it partially supports the AUSL doc's
first claim (cold replicas fill their caches independently) while contradicting
its second (invalidation reaching only one replica).

### Scope

Same limits as §4: one environment, one day, KV vars present. This shows tag
invalidation is **not weaker than** path invalidation here; it does not show
either works where the KV store is absent.

## 5. Recommendation

On this evidence, for an App Router route on Atlas:

1. **Revalidate, then purge the edge.** Either mechanism alone leaves visitors
   on stale content. Both, in order, refresh everything in ~300ms.
   Prefer `purgeTags` over `purgePaths` for the purge step (§3.6): tag the
   routes with the content they render, and WordPress can invalidate by post ID
   without knowing the route table.
2. **An App Router Route Handler is sufficient** for the revalidation step —
   the `pages/api` endpoint is optional, not required (§3.3). `revalidateTag`
   is available there and propagates fleet-wide (§4b), so invalidation can be
   keyed to content rather than to routes.
3. **Do not rely on `x-nextjs-cache`** when debugging this with the customer.
4. **Multi-replica is fine on this environment** (§4). Verified at 7 pods: the
   ISR store is shared and propagates in under a second. The edge purge is not
   at risk of re-caching from a stale replica here. Do not generalise this to
   environments where the KV vars are not provisioned.

The remaining question for the Headless Platform team is §4's scope one —
which environments get a shared store and what determines it — which replaces
the §3.4 question rather than adding to it.

## 6. Scope limits

- Two passes: the §2 matrix ran on a single replica (build `74493237`); §4 ran
  on 6–7 replicas (build `559e3268`) after forcing scale-out. The §2 timings are
  single-replica numbers; the §4 conclusions are the multi-replica ones.
- Next 16.3.5, `cacheComponents` off. Confirm the customer's version before
  relaying — the writeup assumes 16.3.
- `@wpengine/edge-cache` is rate limited (~300 ops/hour). A high-frequency
  publisher could exhaust that; not tested here.
- Convergence windows were 60–75s. "Never" means "not within the window," and
  the edge's `s-maxage=3600` implies up to an hour, but that was not waited out.
- The WordPress side used a REST excerpt bump as the publish trigger. A real
  `save_post` hook may differ in timing, though the GraphQL read reflected the
  change within 3s.

## 7. Related: ticket 8617070 (whistleblowersattorneys.com) — reproduced

Different customer, different account, and on the face of it a different
problem: a WordPress install serving a two-week-old `/graphql` GET response to
platform-internal traffic while external traffic is always fresh. Three support
engineers looked for a stale cache node between the Node runtime and PHP.

Raw: `results/datacache-drift.json`. Script: `scripts/run-datacache-drift.mjs`.
Routes: `app/dcsplit/page.tsx`, `app/dcalign/page.tsx`.

### The observation the ticket turns on

> The page was regenerated ~14:38–14:40 today, still with the old form data —
> and no gfForm request reached PHP. `x-nextjs-cache` went STALE → HIT.

Read as: a request was sent and something intercepted it. But a regeneration
that sends *no request at all* leaves exactly this trace, and it needs no
interceptor. Nginx and Varnish logs will also be empty, because nothing was
sent — so the trace the customer is asking the platform team to pull is
expected to come back empty either way, and its emptiness will be misread as
confirmation.

### The reproduction

Two routes differing in one line. Same backend, same publish, same minutes.

| Route | Route revalidate | Fetch revalidate |
|---|---|---|
| `/dcsplit` | 20s | 1 year |
| `/dcalign` (control) | 20s | 20s |

Signals: `renderedAt` answers "did the component run again" (Full Route Cache);
`upstreamDate` — WordPress's own `date` header, stored in the fetch-cache entry
and replayed verbatim on a hit — answers "did a request leave Node" (Data
Cache).

| Route | Distinct renders | Distinct upstream dates | Went fresh |
|---|---|---|---|
| `/dcsplit` | **8** | **1** | **never** |
| `/dcalign` | 8 | 8 | 5412ms |

`/dcsplit` re-rendered eight times over 150 seconds, every render carrying a new
`renderedAt` and the *same* `upstreamDate`, still serving content from before
the publish. `x-nextjs-cache` cycled `STALE → HIT` — the customer's exact
wording. One network request, eight regenerations, indefinitely stale.

The control rules out the alternatives: same route revalidate, same query, same
environment, and it tracked the publish in 5.4s. The variable is the fetch TTL.

### Why this explains the whole ticket

| Reported | Accounted for by |
|---|---|
| External requests always fresh, internal intermittently stale | The Data Cache is inside the Node process, not on the network path. External traffic cannot traverse it. The asymmetry needs no second network path. |
| Survives portal, object cache, CDN and Varnish purges | None of those touch `.next/cache`. |
| A *clean* rebuild fixes it; ordinary rebuilds do not | Clean rebuild discards `.next/cache`; incremental builds restore it. |
| `max-age=3600` yet content from two weeks prior | That header governs HTTP caches. The Data Cache honours `next.revalidate`, not `Cache-Control`. |
| Intermittent night to night | No `@wpengine/atlas-next`, so each replica keeps its own `.next/cache`; the answer depends on which replica serves and how long it has been up. |
| Sep 3: the fetch reached PHP and answered fresh, yet the build shipped stale | The logged request is probably not the one that fed the render. Consistent with `/contact/` coming from a restored route-cache entry rather than a fresh render. |

`x-nextjs-cache: HIT` is also being used as corroboration in that thread. Per
§3.5 it is not a freshness signal and cannot carry that weight.

### Caveat before relaying

The customer's point 2 cites `__NEXT_DATA__`, which is Pages Router. If that is
accurate then the App Router Data Cache is not the mechanism, and the likely
culprit becomes a module-level Apollo `InMemoryCache` under the default
`cache-first` policy — a long-lived client in a long-lived process, which
produces the identical "regenerated, nothing reached PHP" signature for the
same structural reason. **Confirm which router before asserting a cause.** The
conclusion that survives either way is that the staleness is in-process, not on
the wire.

### What to ask them for

- Which router, and the `fetch`/Apollo cache options on the form query.
- Whether builds are incremental or clean (the Aug 27 result implies incremental).
- A `revalidate` on the form fetch no longer than the route's, which is the fix
  if this is the Data Cache.

### 7.1 On-demand revalidation overrides a long fetch TTL

Follow-up to §7, because it decides whether the drift in §7 is a trap or a
nuisance: does an explicit purge rescue a route whose Data Cache entry is
effectively immortal, or is the entry unreachable until the TTL lapses?

`/dcsplit` (fetch revalidate: 1 year) after `revalidatePath('/dcsplit')` from a
Route Handler:

```
before   modified 2026-09-18T16:29:36   upstream 17:01:40   (frozen for hours)
publish  modified 2026-09-18T19:39:25
after    modified 2026-09-18T19:39:25   upstream 19:39:39   (a request went out)
```

`upstreamDate` moving is the proof: the fetch left the process rather than
being replayed. So **on-demand revalidation invalidates the Data Cache entry
regardless of its remaining TTL**, and the §7 failure is specifically a
*time-based* one. A publish hook wired to `revalidatePath`/`revalidateTag`
would not have produced that ticket at all.

