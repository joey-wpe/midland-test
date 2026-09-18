#!/usr/bin/env node
/**
 * Atlas matrix runner.
 *
 * This is NOT the local harness with a different base URL. On a laptop the
 * harness owned the server: it could restore a pristine .next between cells and
 * read an authoritative origin hit counter. On Atlas it owns nothing. There is
 * no build restore, no process control, and no counter — just N replicas behind
 * a load balancer, each with its own cache.
 *
 * So the method changes. Instead of asking "did the cache invalidate", which is
 * a single-process question, it asks "how much of the fleet went fresh, and how
 * fast". Divergence is measured directly: many samples, grouped by the content
 * version and the rendering replica they came back with. Two different answers
 * alive at the same moment is the failure mode the customer would experience as
 * random intermittent staleness, and it is invisible to any single-process test.
 *
 * Usage:
 *   BASE=https://myapp.wpenginepowered.com SECRET=... node scripts/run-atlas-matrix.mjs
 *
 * Env:
 *   BASE      required, deployed app origin (no trailing slash)
 *   SECRET    required, matches REVALIDATE_SECRET in the Atlas environment
 *   WP_GRAPHQL_URL / WP_USER / WP_APP_PASSWORD  optional, enables auto-publish
 *   ONLY      comma-separated cell ids to run, e.g. ONLY=discover,res-revalidate
 *   SAMPLES   samples per polling round (default 12)
 *   WINDOW    seconds to keep polling after a purge (default 90)
 *   OUT       output file (default results/atlas-raw.json)
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const BASE = (process.env.BASE ?? "").replace(/\/$/, "");
const SECRET = process.env.SECRET ?? "";
const SAMPLES = Number(process.env.SAMPLES ?? 12);
const WINDOW_S = Number(process.env.WINDOW ?? 90);
const OUT = process.env.OUT ?? "results/atlas-raw.json";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",").map((s) => s.trim())) : null;

// The secret may contain spaces or other query-hostile characters, so it must be
// percent-encoded at the call site. redact() still matches on the RAW value, so
// encode only when building URLs.
const QS = encodeURIComponent;

const WP_GRAPHQL_URL =
  process.env.WP_GRAPHQL_URL ?? "https://headlessblogw1.wpenginepowered.com/graphql";
const WP_REST = WP_GRAPHQL_URL.replace(/\/graphql\/?$/, "") + "/wp-json/wp/v2";

if (!BASE || !SECRET) {
  console.error("BASE and SECRET are required. See header comment.");
  process.exit(1);
}

const redact = (s) => s.replaceAll(SECRET, "<secret>").replaceAll(encodeURIComponent(SECRET), "<secret>");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a.map((x) => (typeof x === "string" ? redact(x) : x)));

/* ------------------------------------------------------------------ probes */

/**
 * One GET of a page, with the probe JSON parsed out of the HTML.
 *
 * `bust` appends a unique query param. Atlas fronts the app with Cloudflare,
 * and the pages come back `s-maxage=3600, stale-while-revalidate=31532400` —
 * an edge that will happily serve stale for a year while it revalidates. A
 * plain GET therefore measures Cloudflare, not Next, and would report "still
 * stale" long after the origin went fresh.
 *
 * A unique query string is a distinct Cloudflare cache key (forcing a MISS and
 * a trip to origin) but does NOT change the Next route cache key for a static
 * App Router route, which ignores searchParams. So busted samples read the
 * origin's cache state and unbusted samples read what a real user would see.
 * Both matter and they answer different questions.
 */
async function sample(path, bust = false) {
  const startedAt = Date.now();
  const url = bust
    ? `${BASE}${path}?cb=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    : `${BASE}${path}`;
  const res = await fetch(url, {
    headers: { "user-agent": "atlas-revalidate-harness" },
    cache: "no-store",
  });
  const html = await res.text();
  const m = html.match(/<pre id="probe">([\s\S]*?)<\/pre>/);
  let probe = null;
  if (m) {
    try {
      // React escapes the JSON into the HTML; undo the entities it emits.
      probe = JSON.parse(
        m[1]
          .replaceAll("&quot;", '"')
          .replaceAll("&#x27;", "'")
          .replaceAll("&amp;", "&")
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
      );
    } catch (err) {
      probe = { parseError: String(err), raw: m[1].slice(0, 400) };
    }
  }
  return {
    path,
    bust,
    status: res.status,
    ms: Date.now() - startedAt,
    at: new Date().toISOString(),
    // Every cache layer that might be in play, so a surprise is attributable.
    headers: {
      "x-nextjs-cache": res.headers.get("x-nextjs-cache"),
      "cache-control": res.headers.get("cache-control"),
      age: res.headers.get("age"),
      "x-cache": res.headers.get("x-cache"),
      "cf-cache-status": res.headers.get("cf-cache-status"),
      "x-wpe-instance": res.headers.get("x-wpe-instance"),
      date: res.headers.get("date"),
    },
    probe,
  };
}

/**
 * One measurement round: SAMPLES origin-truth samples (edge bypassed) plus a
 * handful of plain samples showing what a real visitor gets. Concurrent, so a
 * multi-replica fleet is actually spread across.
 */
async function round(path) {
  const [origin, edge] = await Promise.all([
    Promise.all(Array.from({ length: SAMPLES }, () => sample(path, true))),
    Promise.all(Array.from({ length: 4 }, () => sample(path, false))),
  ]);
  return { origin, edge };
}

/**
 * The core reduction. Any single sample only tells you about one replica; the
 * shape of the whole round is the finding.
 */
function summarise(samples) {
  const versions = new Set();
  const instances = new Set();
  const upstreamDates = new Set();
  for (const s of samples) {
    if (s.probe?.modifiedGmt) versions.add(s.probe.modifiedGmt);
    if (s.probe?.instance?.id) instances.add(`${s.probe.instance.id}@${s.probe.instance.host}`);
    if (s.probe?.upstreamDate) upstreamDates.add(s.probe.upstreamDate);
  }
  return {
    n: samples.length,
    distinctVersions: [...versions],
    distinctRenderingInstances: [...instances],
    distinctUpstreamDates: [...upstreamDates],
    // The headline: more than one content version alive at once means clients
    // are getting different answers depending on which replica they land on.
    diverged: versions.size > 1,
    cfStatuses: [...new Set(samples.map((s) => s.headers["cf-cache-status"]))],
    nextCacheStatuses: [...new Set(samples.map((s) => s.headers["x-nextjs-cache"]))],
  };
}

/* ------------------------------------------------------------------- cells */

async function discover() {
  const seen = new Map();
  const kv = [];
  for (let i = 0; i < Math.max(SAMPLES, 20); i++) {
    const res = await fetch(`${BASE}/api/whoami`, { cache: "no-store" });
    const j = await res.json().catch(() => null);
    if (j?.instance) {
      const key = `${j.instance.id}@${j.instance.host}`;
      seen.set(key, { ...j.instance, uptimeSeconds: j.uptimeSeconds, seenCount: (seen.get(key)?.seenCount ?? 0) + 1 });
      kv.push(j.kv);
    }
  }
  const out = {
    replicasObserved: seen.size,
    replicas: [...seen.values()],
    // Whether the shared KV cache is even active decides whether cross-replica
    // convergence is possible at all on this environment.
    kvStore: kv[0] ?? null,
  };
  log(`  replicas observed: ${out.replicasObserved}`);
  log(`  kv store: ${JSON.stringify(out.kvStore)}`);
  return out;
}

/** Bump a post's title so modifiedGmt moves. Falls back to a manual prompt. */
async function publish() {
  const user = process.env.WP_USER;
  const pass = process.env.WP_APP_PASSWORD;
  const postId = process.env.WP_POST_ID ?? "3267";
  if (!user || !pass) {
    if (!process.stdin.isTTY) {
      log("  no WP_USER/WP_APP_PASSWORD and no TTY — skipping publish (cell will be inconclusive).");
      return { mode: "skipped", at: new Date().toISOString() };
    }
    log("  no WP_USER/WP_APP_PASSWORD — manual publish required.");
    log(`  edit and update any post in wp-admin, then press Enter to continue...`);
    await new Promise((r) => process.stdin.once("data", r));
    return { mode: "manual", at: new Date().toISOString() };
  }
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  const stamp = new Date().toISOString();
  const res = await fetch(`${WP_REST}/posts/${postId}`, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({ excerpt: `atlas-revalidate probe ${stamp}` }),
  });
  const body = await res.json().catch(() => null);
  const out = { mode: "rest", status: res.status, at: stamp, modifiedGmt: body?.modified_gmt ?? null };
  log(`  published: status=${res.status} modifiedGmt=${out.modifiedGmt}`);
  return out;
}

/**
 * A cell's purge may be a sequence. Ordering is load-bearing: purging the edge
 * while the origin is still stale simply re-caches the stale copy, so the only
 * sequence that actually reaches a visitor is revalidate-then-purge.
 */
async function purge(urls) {
  const steps = [];
  for (const url of [urls].flat()) {
    const startedAt = new Date().toISOString();
    const res = await fetch(url, { method: "POST", cache: "no-store" });
    const body = await res.json().catch(() => null);
    log(`  purge ${redact(url)} -> ${res.status} instance=${body?.instance?.id ?? "?"} ok=${body?.ok}`);
    steps.push({ url: redact(url), status: res.status, startedAt, finishedAt: new Date().toISOString(), body });
  }
  // Keep the single-step shape for the summary printer.
  return steps.length === 1 ? steps[0] : { steps, ok: steps.every((x) => x.body?.ok), body: { ok: steps.every((x) => x.body?.ok) } };
}

/**
 * Poll until every sample agrees on the post-publish version, or the window
 * expires. Time-to-converge is the number the customer actually feels.
 */
async function converge(path, expectedVersion) {
  const deadline = Date.now() + WINDOW_S * 1000;
  const rounds = [];
  let firstFreshMs = null;
  let allFreshMs = null;
  let edgeAllFreshMs = null;
  const t0 = Date.now();
  while (Date.now() < deadline) {
    const { origin, edge } = await round(path);
    const s = summarise(origin);
    const e = summarise(edge);
    const fresh = origin.filter((x) => x.probe?.modifiedGmt === expectedVersion).length;
    const edgeFresh = edge.filter((x) => x.probe?.modifiedGmt === expectedVersion).length;
    const elapsed = Date.now() - t0;
    if (fresh > 0 && firstFreshMs === null) firstFreshMs = elapsed;
    if (fresh === origin.length && allFreshMs === null) allFreshMs = elapsed;
    if (edgeFresh === edge.length && edgeAllFreshMs === null) edgeAllFreshMs = elapsed;
    rounds.push({ elapsedMs: elapsed, freshCount: fresh, edgeFreshCount: edgeFresh, ...s, edge: e, samples: origin, edgeSamples: edge });
    log(`    +${(elapsed / 1000).toFixed(0)}s ${path} origin=${fresh}/${origin.length} edge=${edgeFresh}/${edge.length} versions=${s.distinctVersions.length} diverged=${s.diverged}`);
    if (allFreshMs !== null && edgeAllFreshMs !== null) break;
    await sleep(5000);
  }
  return {
    path,
    expectedVersion,
    firstFreshMs,
    allFreshMs,
    convergedWithinWindow: allFreshMs !== null,
    // Origin fresh but edge stale is its own failure, and the one the customer's
    // visitors actually experience.
    edgeAllFreshMs,
    edgeConvergedWithinWindow: edgeAllFreshMs !== null,
    // A round that saw two versions at once is the smoking gun, and it is worth
    // surfacing even if the fleet eventually converged.
    everDiverged: rounds.some((r) => r.diverged),
    rounds,
  };
}

/* -------------------------------------------------------------------- main */

/**
 * Each cell: establish a stale baseline, publish, confirm still-stale (which
 * proves the cache is real and the test isn't measuring nothing), purge by one
 * mechanism, then watch the fleet converge.
 */
const CELLS = [
  { id: "res-revalidate", route: "/a", purge: (p) => `${BASE}/api/revalidate?secret=${QS(SECRET)}&path=${QS(p)}`,
    note: "res.revalidate() from pages/api against an App Router path — the mechanism under test." },
  { id: "pages-revalidate-path", route: "/c", purge: (p) => `${BASE}/api/revalidate-path?secret=${QS(SECRET)}&path=${QS(p)}`,
    note: "revalidatePath from pages/api. Expected to throw E263 (no work store)." },
  { id: "app-revalidate-path", route: "/rh", purge: (p) => `${BASE}/api/app-revalidate-path?secret=${QS(SECRET)}&path=${QS(p)}`,
    note: "revalidatePath from an App Router Route Handler — settles RESULTS.md §8." },
  { id: "app-revalidate-tag", route: "/rt", purge: () => `${BASE}/api/app-revalidate-tag?secret=${QS(SECRET)}&tag=rt-content`,
    note: "revalidateTag from a Route Handler. atlas-next's handler appears not to forward tags to KV." },
  { id: "revalidate-then-purge", route: "/a", purge: (p) => [
      `${BASE}/api/revalidate?secret=${QS(SECRET)}&path=${QS(p)}`,
      `${BASE}/api/purge-edge?secret=${QS(SECRET)}&paths=${QS(p)}`,
    ],
    note: "The production sequence: revalidate the origin, THEN purge the edge. The only combination that reaches a real visitor." },
  { id: "edge-purge", route: "/e", purge: (p) => `${BASE}/api/purge-edge?secret=${QS(SECRET)}&paths=${QS(p)}`,
    note: "@wpengine/edge-cache purgePaths — the layer res.revalidate never touches." },
];

async function main() {
  const results = { base: BASE, startedAt: new Date().toISOString(), config: { SAMPLES, WINDOW_S }, cells: {} };

  if (!ONLY || ONLY.has("discover")) {
    log("\n[discover] counting replicas and checking KV store");
    results.cells.discover = await discover();
  }

  for (const cell of CELLS) {
    if (ONLY && !ONLY.has(cell.id)) continue;
    log(`\n[${cell.id}] ${cell.note}`);

    log(`  baseline ${cell.route}`);
    const baselineRound = await round(cell.route);
    const baseline = baselineRound.origin;
    const baseSummary = summarise(baseline);
    log(`  baseline versions=${JSON.stringify(baseSummary.distinctVersions)} replicas=${baseSummary.distinctRenderingInstances.length}`);

    const published = await publish();
    // Whatever WordPress now reports is the target; read it live so a manual
    // publish works identically to the REST path.
    const truth = await sample("/control");
    const expected = truth.probe?.modifiedGmt ?? published.modifiedGmt;
    log(`  expected version: ${expected}`);

    log(`  confirming still stale before purge`);
    const preStale = summarise((await round(cell.route)).origin);
    const wasStale = !preStale.distinctVersions.includes(expected);
    log(`  still stale: ${wasStale}${wasStale ? "" : "  <-- cache did not hold; cell is inconclusive"}`);

    const purgeResult = await purge(cell.purge(cell.route));
    const convergence = await converge(cell.route, expected);

    results.cells[cell.id] = {
      note: cell.note, route: cell.route,
      baseline: { ...baseSummary, samples: baseline },
      published, expectedVersion: expected,
      preStale: { ...preStale, wasStale },
      purge: purgeResult,
      convergence,
    };
  }

  results.finishedAt = new Date().toISOString();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  log(`\nwrote ${OUT}`);

  log("\n=== summary ===");
  for (const [id, c] of Object.entries(results.cells)) {
    if (id === "discover") {
      log(`discover: ${c.replicasObserved} replica(s) observed, kv=${c.kvStore?.kvUrlPresent ? "present" : "absent"}`);
      continue;
    }
    const purgeOk = c.purge.body?.ok;
    log(
      `${id}: purge.ok=${purgeOk} stale-before=${c.preStale.wasStale} ` +
        `origin-all-fresh=${c.convergence.allFreshMs ?? "NEVER"}ms ` +
        `edge-all-fresh=${c.convergence.edgeAllFreshMs ?? "NEVER"}ms ` +
        `diverged=${c.convergence.everDiverged}`
    );
    if (!purgeOk) log(`  purge error: ${JSON.stringify(c.purge.body?.error)?.slice(0, 200)}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
