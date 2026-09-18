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

const WP_GRAPHQL_URL =
  process.env.WP_GRAPHQL_URL ?? "https://headlessblogw1.wpenginepowered.com/graphql";
const WP_REST = WP_GRAPHQL_URL.replace(/\/graphql\/?$/, "") + "/wp-json/wp/v2";

if (!BASE || !SECRET) {
  console.error("BASE and SECRET are required. See header comment.");
  process.exit(1);
}

const redact = (s) => s.replaceAll(SECRET, "<secret>");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a.map((x) => (typeof x === "string" ? redact(x) : x)));

/* ------------------------------------------------------------------ probes */

/** One GET of a page, with the probe JSON parsed out of the HTML. */
async function sample(path) {
  const startedAt = Date.now();
  const res = await fetch(`${BASE}${path}`, {
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

/** SAMPLES sequential-ish GETs of one path, run concurrently to catch replicas. */
async function round(path) {
  return Promise.all(Array.from({ length: SAMPLES }, () => sample(path)));
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

async function purge(url) {
  const startedAt = new Date().toISOString();
  const res = await fetch(url, { method: "POST", cache: "no-store" });
  const body = await res.json().catch(() => null);
  log(`  purge ${redact(url)} -> ${res.status} instance=${body?.instance?.id ?? "?"}`);
  return { url: redact(url), status: res.status, startedAt, finishedAt: new Date().toISOString(), body };
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
  const t0 = Date.now();
  while (Date.now() < deadline) {
    const samples = await round(path);
    const s = summarise(samples);
    const fresh = samples.filter((x) => x.probe?.modifiedGmt === expectedVersion).length;
    const elapsed = Date.now() - t0;
    if (fresh > 0 && firstFreshMs === null) firstFreshMs = elapsed;
    if (fresh === samples.length && allFreshMs === null) allFreshMs = elapsed;
    rounds.push({ elapsedMs: elapsed, freshCount: fresh, ...s, samples });
    log(`    +${(elapsed / 1000).toFixed(0)}s ${path} fresh=${fresh}/${samples.length} versions=${s.distinctVersions.length} diverged=${s.diverged}`);
    if (allFreshMs !== null) break;
    await sleep(5000);
  }
  return {
    path,
    expectedVersion,
    firstFreshMs,
    allFreshMs,
    convergedWithinWindow: allFreshMs !== null,
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
  { id: "res-revalidate", route: "/a", purge: (p) => `${BASE}/api/revalidate?secret=${SECRET}&path=${p}`,
    note: "res.revalidate() from pages/api against an App Router path — the mechanism under test." },
  { id: "pages-revalidate-path", route: "/c", purge: (p) => `${BASE}/api/revalidate-path?secret=${SECRET}&path=${p}`,
    note: "revalidatePath from pages/api. Expected to throw E263 (no work store)." },
  { id: "app-revalidate-path", route: "/rh", purge: (p) => `${BASE}/api/app-revalidate-path?secret=${SECRET}&path=${p}`,
    note: "revalidatePath from an App Router Route Handler — settles RESULTS.md §8." },
  { id: "app-revalidate-tag", route: "/rt", purge: () => `${BASE}/api/app-revalidate-tag?secret=${SECRET}&tag=rt-content`,
    note: "revalidateTag from a Route Handler. atlas-next's handler appears not to forward tags to KV." },
  { id: "edge-purge", route: "/e", purge: (p) => `${BASE}/api/purge-edge?secret=${SECRET}&paths=${p}`,
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
    const baseline = await round(cell.route);
    const baseSummary = summarise(baseline);
    log(`  baseline versions=${JSON.stringify(baseSummary.distinctVersions)} replicas=${baseSummary.distinctRenderingInstances.length}`);

    const published = await publish();
    // Whatever WordPress now reports is the target; read it live so a manual
    // publish works identically to the REST path.
    const truth = await sample("/control");
    const expected = truth.probe?.modifiedGmt ?? published.modifiedGmt;
    log(`  expected version: ${expected}`);

    log(`  confirming still stale before purge`);
    const preStale = summarise(await round(cell.route));
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
        `first-fresh=${c.convergence.firstFreshMs ?? "never"}ms ` +
        `all-fresh=${c.convergence.allFreshMs ?? "NEVER"}ms ` +
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
