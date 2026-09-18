#!/usr/bin/env node
/**
 * Does purgeTags() actually purge the Atlas edge, and is it tag-discriminating?
 *
 * §3.1/3.2 established the edge is the real problem: nothing Next does
 * invalidates it, and purgePaths fixes that only if the origin was refreshed
 * first. But purgePaths is the wrong ergonomics for the customer. A save_post
 * hook knows a post ID; it does not know which routes render that post, so
 * purgePaths forces a post-ID-to-paths map maintained in PHP and kept in sync
 * with Next routing by hand. purgeTags is the shape that fits.
 *
 * The naive test — purge a tag, watch pages go fresh — cannot distinguish
 * "the tag purge worked" from "something purged everything." Nor can it confirm
 * the Cache-Tag headers landed at all, since Cloudflare strips Cache-Tag before
 * the response reaches a client, so there is nothing to read directly.
 *
 * Hence two arms, narrow first:
 *
 *   narrow  purgeTags(['route-a'])    expect /a fresh, /c and /rt STILL STALE
 *   broad   purgeTags(['post-3267'])  expect /a, /c, /rh, /rt all fresh, one call
 *
 * The narrow arm is the load-bearing one. Untouched routes staying stale while
 * the tagged one refreshes is the only observation that proves the edge is
 * honouring these specific tags. The broad arm then measures the fan-out the
 * customer actually wants.
 *
 * Ordering is enforced per §3.2: publish, refresh the origin, CONFIRM the edge
 * is still serving stale, and only then purge. Purging an edge that fronts a
 * stale origin just re-caches the stale copy, and every call returns 200
 * either way, so the stale-check is not optional — without it a pass is
 * indistinguishable from a no-op.
 *
 * Budget note: @wpengine/edge-cache allows ~300 purge operations per hour per
 * environment. This run spends 2 (one per arm); batching tags into a single
 * call is one operation regardless of tag count, which is the right instinct.
 *
 * Usage:
 *   BASE=... SECRET=... WP_USER=... WP_APP_PASSWORD=... node scripts/run-edge-tag-purge.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const BASE = (process.env.BASE ?? "").replace(/\/$/, "");
const SECRET = process.env.SECRET ?? "";
const WINDOW_S = Number(process.env.WINDOW ?? 60);
const POLL_MS = Number(process.env.POLL_MS ?? 2000);
const EDGE_SAMPLES = Number(process.env.EDGE_SAMPLES ?? 4);
const OUT = process.env.OUT ?? "results/edge-tag-purge.json";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;

const QS = encodeURIComponent;
const WP_GRAPHQL_URL =
  process.env.WP_GRAPHQL_URL ?? "https://headlessblogw1.wpenginepowered.com/graphql";
const WP_REST = WP_GRAPHQL_URL.replace(/\/graphql\/?$/, "") + "/wp-json/wp/v2";
const WP_POST_ID = process.env.WP_POST_ID ?? "3267";

if (!BASE || !SECRET) {
  console.error("BASE and SECRET are required.");
  process.exit(1);
}

const redact = (s) =>
  String(s).replaceAll(SECRET, "<secret>").replaceAll(encodeURIComponent(SECRET), "<secret>");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a.map((x) => (typeof x === "string" ? redact(x) : x)));

/* ------------------------------------------------------------------ probes */

/**
 * `bust` picks the layer being measured, and the two answer different
 * questions. Unbusted is a real visitor's request and reads Cloudflare;
 * busted is a unique edge cache key, so it misses and reports the origin.
 * This test needs both: the origin must be fresh for the purge to be
 * meaningful, and the edge is the thing under test.
 */
async function sample(path, bust) {
  const url = bust
    ? `${BASE}${path}?cb=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    : `${BASE}${path}`;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "atlas-edge-tag-purge" },
      cache: "no-store",
    });
    const html = await res.text();
    const m = html.match(/<pre id="probe">([\s\S]*?)<\/pre>/);
    let probe = null;
    if (m) {
      try {
        probe = JSON.parse(
          m[1].replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&amp;", "&")
        );
      } catch (err) {
        probe = { parseError: String(err) };
      }
    }
    return {
      path,
      bust,
      status: res.status,
      modifiedGmt: probe?.modifiedGmt ?? null,
      renderedAt: probe?.renderedAt ?? null,
      serving: res.headers.get("x-serving-instance"),
      rendering: probe?.instance?.id ?? null,
      cf: res.headers.get("cf-cache-status"),
      age: res.headers.get("age"),
      nextCache: res.headers.get("x-nextjs-cache"),
      at: new Date().toISOString(),
    };
  } catch (err) {
    return { path, bust, error: String(err), at: new Date().toISOString() };
  }
}

/** Edge state for one route: several plain GETs, since PoPs can differ. */
async function edgeState(path, expected) {
  const s = await Promise.all(Array.from({ length: EDGE_SAMPLES }, () => sample(path, false)));
  const ok = s.filter((x) => !x.error);
  const fresh = ok.filter((x) => x.modifiedGmt === expected).length;
  return {
    path,
    fresh,
    n: ok.length,
    allFresh: ok.length > 0 && fresh === ok.length,
    versions: [...new Set(ok.map((x) => x.modifiedGmt))],
    cf: [...new Set(ok.map((x) => x.cf))],
    maxAge: Math.max(0, ...ok.map((x) => Number(x.age ?? 0))),
    samples: s,
  };
}

async function originState(path, expected) {
  const s = await Promise.all(Array.from({ length: 4 }, () => sample(path, true)));
  const ok = s.filter((x) => !x.error);
  const fresh = ok.filter((x) => x.modifiedGmt === expected).length;
  return { path, fresh, n: ok.length, allFresh: fresh === ok.length && ok.length > 0, samples: s };
}

/* -------------------------------------------------------------------- steps */

async function publish() {
  const user = process.env.WP_USER;
  const pass = process.env.WP_APP_PASSWORD;
  if (!user || !pass) return { mode: "skipped" };
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  const stamp = new Date().toISOString();
  const res = await fetch(`${WP_REST}/posts/${WP_POST_ID}`, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({ excerpt: `edge-tag probe ${stamp}` }),
  });
  const body = await res.json().catch(() => null);
  log(`  published: ${res.status} modifiedGmt=${body?.modified_gmt}`);
  return { mode: "rest", status: res.status, modifiedGmt: body?.modified_gmt ?? null };
}

/** Refresh the origin for each route. Must precede any edge purge (§3.2). */
async function refreshOrigin(paths) {
  const steps = [];
  for (const p of paths) {
    const url = `${BASE}/api/app-revalidate-path?path=${QS(p)}&secret=${QS(SECRET)}`;
    const res = await fetch(url, { method: "POST", cache: "no-store" });
    const body = await res.json().catch(() => null);
    steps.push({ path: p, status: res.status, ok: body?.ok, pod: body?.instance?.id });
  }
  log(`  origin revalidated: ${steps.map((s) => `${s.path}=${s.ok}`).join(" ")}`);
  return steps;
}

async function purgeTags(tags) {
  const url = `${BASE}/api/purge-tags?tags=${QS(tags.join(","))}&secret=${QS(SECRET)}`;
  const res = await fetch(url, { method: "POST", cache: "no-store" });
  const body = await res.json().catch(() => null);
  log(`  purgeTags(${JSON.stringify(tags)}) -> ${res.status} ok=${body?.ok} pod=${body?.instance?.id}`);
  if (body?.error) log(`    error: ${JSON.stringify(body.error)}`);
  return { tags, status: res.status, body, at: new Date().toISOString() };
}

/* --------------------------------------------------------------------- arms */

/**
 * @param expectFresh routes the purge should refresh
 * @param expectStale routes it must leave alone — the discriminating control
 */
async function arm({ id, tags, expectFresh, expectStale, note }) {
  log(`\n=== ${id}: purgeTags(${JSON.stringify(tags)})`);
  log(`  ${note}`);
  const all = [...expectFresh, ...expectStale];

  // Warm every route at the edge so each has a cached copy to invalidate.
  await Promise.all(all.map((p) => edgeState(p, null)));

  const published = await publish();
  const expected = published.modifiedGmt;
  await sleep(3000);

  await refreshOrigin(all);
  await sleep(1500);

  const originBefore = {};
  for (const p of all) originBefore[p] = await originState(p, expected);
  const originReady = all.every((p) => originBefore[p].allFresh);
  log(`  origin fresh on all routes: ${originReady} (${all.map((p) => `${p}=${originBefore[p].fresh}/${originBefore[p].n}`).join(" ")})`);

  // Without this the arm proves nothing — a route that was already fresh at
  // the edge would read as a pass no matter what the purge did.
  const edgeBefore = {};
  for (const p of all) edgeBefore[p] = await edgeState(p, expected);
  const edgeStale = all.every((p) => edgeBefore[p].fresh === 0);
  log(`  edge stale on all routes before purge: ${edgeStale} (${all.map((p) => `${p} age=${edgeBefore[p].maxAge}`).join(" ")})`);

  const t0 = Date.now();
  const purge = await purgeTags(tags);

  const deadline = Date.now() + WINDOW_S * 1000;
  const rounds = [];
  const freshMs = {};
  while (Date.now() < deadline) {
    const elapsed = Date.now() - t0;
    const state = {};
    for (const p of all) {
      state[p] = await edgeState(p, expected);
      if (state[p].allFresh && freshMs[p] === undefined) freshMs[p] = elapsed;
    }
    rounds.push({ elapsedMs: elapsed, state });
    log(`    +${(elapsed / 1000).toFixed(1)}s ${all.map((p) => `${p}=${state[p].fresh}/${state[p].n}`).join(" ")}`);
    if (expectFresh.every((p) => freshMs[p] !== undefined)) break;
    await sleep(POLL_MS);
  }

  // A purge that also refreshed the routes it was not supposed to touch would
  // mean the tags are not discriminating, whatever the headline looks like.
  const leaked = expectStale.filter((p) => freshMs[p] !== undefined);
  const verdict = {
    targetsRefreshed: expectFresh.filter((p) => freshMs[p] !== undefined),
    targetsMissed: expectFresh.filter((p) => freshMs[p] === undefined),
    controlLeaked: leaked,
    discriminating: expectStale.length === 0 ? null : leaked.length === 0,
  };
  log(`  verdict: refreshed=[${verdict.targetsRefreshed}] missed=[${verdict.targetsMissed}] leaked=[${leaked}]`);

  return { id, tags, note, published, originBefore, originReady, edgeBefore, edgeStale, purge, freshMs, verdict, rounds };
}

/* ---------------------------------------------------------------------- run */

const ARMS = [
  {
    id: "narrow",
    tags: ["route-a"],
    expectFresh: ["/a"],
    expectStale: ["/c", "/rt"],
    note: "proves the Cache-Tag headers landed and the edge discriminates by tag",
  },
  {
    id: "broad",
    tags: ["post-3267"],
    expectFresh: ["/a", "/c", "/rh", "/rt"],
    expectStale: [],
    note: "one content-keyed call, many routes — the shape a save_post hook can produce",
  },
];

const out = { startedAt: new Date().toISOString(), base: BASE, arms: [] };
log(`base=${BASE} window=${WINDOW_S}s poll=${POLL_MS}ms`);

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
    `${a.id.padEnd(7)} originReady=${a.originReady} edgeStaleBefore=${a.edgeStale} ` +
      `purgeOk=${a.purge.body?.ok} refreshed=[${a.verdict.targetsRefreshed}] ` +
      `missed=[${a.verdict.targetsMissed}] discriminating=${a.verdict.discriminating}`
  );
  for (const [p, ms] of Object.entries(a.freshMs)) log(`         ${p} edge fresh at ${ms}ms`);
}
log(`\nwrote ${OUT}`);
