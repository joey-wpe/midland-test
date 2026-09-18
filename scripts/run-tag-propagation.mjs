#!/usr/bin/env node
/**
 * Does revalidateTag propagate across replicas?
 *
 * RESULTS-ATLAS.md §4 proved the *page* store is shared: a res.revalidate() on
 * one pod changed what all seven served. But §3.3 left a hole. The atlas-next
 * cache handler's revalidateTag delegates only to the local filesystem cache,
 * and tag invalidation was only ever exercised on a single replica. Page-store
 * sharing does not imply tag-invalidation sharing — they are different code
 * paths — and tag-based invalidation is precisely the granular mechanism the
 * AUSL recommendation builds an entire external Redis key namespace to obtain.
 * If tags propagate, that layer is redundant here. If they do not, it is not.
 *
 * The design turns on one distinction the earlier run could not make:
 *
 *   an invalidation that PROPAGATES  — pod B is told its copy is dead
 *   a write that is merely SHARED    — pod A regenerates into shared storage
 *                                      and pod B happens to read from there
 *
 * Both look identical if you only watch whether the fleet goes fresh. They are
 * told apart by the control arm: /rh is purged with revalidatePath under the
 * same fleet, in the same run, minutes apart. Same storage, same load balancer,
 * same pods. If /rh converges and /rt does not, the difference is the tag path
 * and nothing else. If both converge identically, tag invalidation is no weaker
 * than path invalidation on this platform.
 *
 * Two things make this sharper than the §4 run:
 *
 *  1. x-serving-instance (middleware.ts). §4 inferred sharing from many
 *     rendering-pod IDs collapsing to one. Now the serving pod is named
 *     outright, so "pod B served pod A's render" is read off a single sample
 *     rather than reconstructed from a distribution.
 *  2. 600ms polling. §4 measured convergence at <950ms with 5s rounds, which
 *     means the real number was never resolved — only bounded.
 *
 * Usage:
 *   BASE=... SECRET=... WP_USER=... WP_APP_PASSWORD=... node scripts/run-tag-propagation.mjs
 *
 * Env: BASE, SECRET required. WP_USER/WP_APP_PASSWORD enable the publish step.
 *      SAMPLES (default 16), WINDOW (default 45s), POLL_MS (default 600),
 *      ONLY=tag|path, OUT (default results/tag-propagation.json).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const BASE = (process.env.BASE ?? "").replace(/\/$/, "");
const SECRET = process.env.SECRET ?? "";
const SAMPLES = Number(process.env.SAMPLES ?? 16);
const WINDOW_S = Number(process.env.WINDOW ?? 45);
const POLL_MS = Number(process.env.POLL_MS ?? 600);
const OUT = process.env.OUT ?? "results/tag-propagation.json";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",").map((s) => s.trim())) : null;

// The secret contains spaces, so it must be encoded at every call site.
const QS = encodeURIComponent;
const WP_GRAPHQL_URL =
  process.env.WP_GRAPHQL_URL ?? "https://headlessblogw1.wpenginepowered.com/graphql";
const WP_REST = WP_GRAPHQL_URL.replace(/\/graphql\/?$/, "") + "/wp-json/wp/v2";
const WP_POST_ID = process.env.WP_POST_ID ?? "3267";

if (!BASE || !SECRET) {
  console.error("BASE and SECRET are required. See header comment.");
  process.exit(1);
}

const redact = (s) =>
  String(s).replaceAll(SECRET, "<secret>").replaceAll(encodeURIComponent(SECRET), "<secret>");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a.map((x) => (typeof x === "string" ? redact(x) : x)));

/* ------------------------------------------------------------------ probes */

async function sample(path) {
  // Always cache-busted. A plain GET measures Cloudflare, not Next, and this
  // test is entirely about origin-side cache state.
  const url = `${BASE}${path}?cb=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "atlas-tag-propagation" },
      cache: "no-store",
    });
    const html = await res.text();
    const m = html.match(/<pre id="probe">([\s\S]*?)<\/pre>/);
    let probe = null;
    if (m) {
      try {
        probe = JSON.parse(
          m[1]
            .replaceAll("&quot;", '"')
            .replaceAll("&#x27;", "'")
            .replaceAll("&amp;", "&")
            .replaceAll("&lt;", "<")
            .replaceAll("&gt;", ">")
        );
      } catch (err) {
        probe = { parseError: String(err) };
      }
    }
    const serving = res.headers.get("x-serving-instance");
    const rendering = probe?.instance?.id ?? null;
    return {
      path,
      status: res.status,
      ms: Date.now() - startedAt,
      at: new Date().toISOString(),
      serving,
      rendering,
      // The whole point. True means this pod returned HTML it did not produce,
      // which requires shared storage — no inference from a distribution.
      servedOthersRender: Boolean(serving && rendering && serving !== rendering),
      modifiedGmt: probe?.modifiedGmt ?? null,
      renderedAt: probe?.renderedAt ?? null,
      nextCache: res.headers.get("x-nextjs-cache"),
      cf: res.headers.get("cf-cache-status"),
    };
  } catch (err) {
    return { path, at: new Date().toISOString(), error: String(err) };
  }
}

const roundOf = (path) => Promise.all(Array.from({ length: SAMPLES }, () => sample(path)));

function summarise(samples, expectedVersion, purgePod) {
  const ok = samples.filter((s) => !s.error);
  const serving = new Set(ok.map((s) => s.serving).filter(Boolean));
  const rendering = new Set(ok.map((s) => s.rendering).filter(Boolean));
  const versions = new Set(ok.map((s) => s.modifiedGmt).filter(Boolean));
  const fresh = ok.filter((s) => s.modifiedGmt === expectedVersion);
  // Freshness observed on a pod that did NOT handle the purge is the single
  // strongest signal: that pod learned about the invalidation from elsewhere.
  const freshOnOtherPods = new Set(
    fresh.map((s) => s.serving).filter((id) => id && id !== purgePod)
  );
  return {
    n: ok.length,
    errors: samples.length - ok.length,
    servingPods: [...serving],
    renderingPods: [...rendering],
    distinctVersions: [...versions],
    diverged: versions.size > 1,
    freshCount: fresh.length,
    crossPodServes: ok.filter((s) => s.servedOthersRender).length,
    freshOnNonPurgingPods: [...freshOnOtherPods],
    nextCacheStatuses: [...new Set(ok.map((s) => s.nextCache))],
  };
}

/* -------------------------------------------------------------------- steps */

async function discover() {
  const seen = new Map();
  let kv = null;
  for (let i = 0; i < 30; i++) {
    const j = await fetch(`${BASE}/api/whoami`, { cache: "no-store" })
      .then((r) => r.json())
      .catch(() => null);
    if (j?.instance) {
      seen.set(j.instance.id, { ...j.instance, uptimeSeconds: j.uptimeSeconds });
      kv ??= j.kv;
    }
  }
  log(`  pods visible: ${seen.size} [${[...seen.keys()].join(", ")}]`);
  return { podsObserved: seen.size, pods: [...seen.values()], kv };
}

async function publish() {
  const user = process.env.WP_USER;
  const pass = process.env.WP_APP_PASSWORD;
  if (!user || !pass) {
    log("  no WP credentials — skipping publish, run will be inconclusive.");
    return { mode: "skipped" };
  }
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  const stamp = new Date().toISOString();
  const res = await fetch(`${WP_REST}/posts/${WP_POST_ID}`, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({ excerpt: `tag-propagation probe ${stamp}` }),
  });
  const body = await res.json().catch(() => null);
  log(`  published: ${res.status} modifiedGmt=${body?.modified_gmt}`);
  return { mode: "rest", status: res.status, modifiedGmt: body?.modified_gmt ?? null };
}

async function callPurge(url) {
  const res = await fetch(url, { method: "POST", cache: "no-store" });
  const body = await res.json().catch(() => null);
  const pod = body?.instance?.id ?? null;
  log(`  purge -> ${res.status} ok=${body?.ok} handled by pod ${pod}`);
  return { url: redact(url), status: res.status, pod, body, at: new Date().toISOString() };
}

async function converge(path, expectedVersion, purgePod, t0) {
  const deadline = Date.now() + WINDOW_S * 1000;
  const rounds = [];
  let firstFreshMs = null;
  let allFreshMs = null;
  let firstFreshOnOtherPodMs = null;
  while (Date.now() < deadline) {
    const samples = await roundOf(path);
    const s = summarise(samples, expectedVersion, purgePod);
    const elapsed = Date.now() - t0;
    if (s.freshCount > 0 && firstFreshMs === null) firstFreshMs = elapsed;
    if (s.freshOnNonPurgingPods.length > 0 && firstFreshOnOtherPodMs === null)
      firstFreshOnOtherPodMs = elapsed;
    if (s.freshCount === s.n && s.n > 0 && allFreshMs === null) allFreshMs = elapsed;
    rounds.push({ elapsedMs: elapsed, ...s, samples });
    log(
      `    +${(elapsed / 1000).toFixed(1)}s fresh=${s.freshCount}/${s.n} ` +
        `pods=${s.servingPods.length} crossPodServes=${s.crossPodServes} ` +
        `freshOnOthers=${s.freshOnNonPurgingPods.length} versions=${s.distinctVersions.length}`
    );
    if (allFreshMs !== null) break;
    await sleep(POLL_MS);
  }
  return { firstFreshMs, firstFreshOnOtherPodMs, allFreshMs, rounds };
}

/**
 * One arm. Both arms are identical except for the route and the endpoint, which
 * is the point — any difference in the result is attributable to the mechanism.
 */
async function arm({ id, path, purgeUrl, mechanism }) {
  log(`\n=== ${id}: ${mechanism} on ${path}`);

  log("  baseline (pre-publish)");
  const baseline = summarise(await roundOf(path), null, null);
  log(
    `    serving pods=${baseline.servingPods.length} rendering pods=${baseline.renderingPods.length} ` +
      `crossPodServes=${baseline.crossPodServes}/${baseline.n} version=${baseline.distinctVersions[0]}`
  );

  const published = await publish();
  const expected = published.modifiedGmt;
  await sleep(3000); // let WPGraphQL reflect the write

  // Without this the run proves nothing: if the route had already lapsed, any
  // freshness afterwards is ordinary expiry, not the purge.
  const preCheck = summarise(await roundOf(path), expected, null);
  const stillStale = preCheck.freshCount === 0;
  log(`  still stale before purge: ${stillStale} (fresh=${preCheck.freshCount}/${preCheck.n})`);

  const t0 = Date.now();
  const purge = await callPurge(purgeUrl);
  const result = await converge(path, expected, purge.pod, t0);

  return { id, path, mechanism, baseline, published, preCheck, stillStale, purge, ...result };
}

/* --------------------------------------------------------------------- run */

const ARMS = [
  {
    id: "tag",
    path: "/rt",
    mechanism: "revalidateTag('rt-content') from an App Router Route Handler",
    purgeUrl: `${BASE}/api/app-revalidate-tag?tag=${QS("rt-content")}&secret=${QS(SECRET)}`,
  },
  {
    // Control. Known to propagate (RESULTS-ATLAS.md §4), so if this arm fails
    // the fleet is misbehaving and the tag result is not interpretable.
    id: "path",
    path: "/rh",
    mechanism: "revalidatePath('/rh') from an App Router Route Handler",
    purgeUrl: `${BASE}/api/app-revalidate-path?path=${QS("/rh")}&secret=${QS(SECRET)}`,
  },
];

const out = { startedAt: new Date().toISOString(), base: BASE, samples: SAMPLES, pollMs: POLL_MS, arms: [] };

log(`base=${BASE} samples=${SAMPLES} poll=${POLL_MS}ms window=${WINDOW_S}s`);
log("\n=== discover");
out.discover = await discover();

for (const a of ARMS) {
  if (ONLY && !ONLY.has(a.id)) continue;
  out.arms.push(await arm(a));
}

out.finishedAt = new Date().toISOString();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, redact(JSON.stringify(out, null, 2)));

log("\n=== summary");
for (const a of out.arms) {
  log(
    `${a.id.padEnd(5)} stillStaleBefore=${a.stillStale} purgePod=${a.purge.pod} ` +
      `firstFresh=${a.firstFreshMs}ms firstFreshOnOtherPod=${a.firstFreshOnOtherPodMs}ms ` +
      `allFresh=${a.allFreshMs}ms`
  );
}
log(`\nwrote ${OUT}`);
