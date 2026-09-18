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
