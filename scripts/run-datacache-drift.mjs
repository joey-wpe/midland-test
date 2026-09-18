#!/usr/bin/env node
/**
 * Reproduction for ticket 8617070 — "a page regenerated but no request reached
 * PHP, so something must be caching between Node and WordPress."
 *
 * It measures whether a route can re-render repeatedly, for minutes, serving
 * content that predates a WordPress publish, while issuing zero upstream
 * requests. If it can, the ticket's central inference collapses: the absence of
 * a request in the WordPress logs stops being evidence of an interceptor and
 * becomes the expected behaviour of a Data Cache entry outliving the route that
 * reads it.
 *
 * Two arms, identical but for one line of route config:
 *
 *   /dcsplit   route revalidate 20s, fetch revalidate 1 year   (the bug shape)
 *   /dcalign   route revalidate 20s, fetch revalidate 20s      (control)
 *
 * The control is what makes this an experiment rather than an anecdote. Both
 * see the same publish in the same minutes against the same backend, so if
 * dcalign tracks the change and dcsplit does not, the difference is the fetch
 * TTL and nothing else.
 *
 * Two independent signals are recorded per sample, and they answer different
 * questions:
 *
 *   renderedAt    did the component run again?   (Full Route Cache)
 *   upstreamDate  did a request leave Node?      (Data Cache)
 *
 * upstreamDate is WordPress's own `date` response header, stored in the
 * fetch-cache entry and replayed verbatim on a hit. renderedAt advancing while
 * upstreamDate is frozen is the signature being hunted: a real render, no
 * network. That combination is what produces a WordPress access log with
 * nothing in it.
 *
 * Usage:
 *   BASE=... WP_USER=... WP_APP_PASSWORD=... node scripts/run-datacache-drift.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const BASE = (process.env.BASE ?? "").replace(/\/$/, "");
const WINDOW_S = Number(process.env.WINDOW ?? 150);
const POLL_MS = Number(process.env.POLL_MS ?? 5000);
const OUT = process.env.OUT ?? "results/datacache-drift.json";
const ROUTES = (process.env.ROUTES ?? "/dcsplit,/dcalign").split(",");

const WP_GRAPHQL_URL =
  process.env.WP_GRAPHQL_URL ?? "https://headlessblogw1.wpenginepowered.com/graphql";
const WP_REST = WP_GRAPHQL_URL.replace(/\/graphql\/?$/, "") + "/wp-json/wp/v2";
const WP_POST_ID = process.env.WP_POST_ID ?? "3267";

if (!BASE) {
  console.error("BASE is required.");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function sample(path) {
  // Cache-busted: this is a question about Next's caches, not Cloudflare's.
  const url = `${BASE}${path}?cb=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const res = await fetch(url, { cache: "no-store", headers: { "user-agent": "atlas-dc-drift" } });
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
      at: new Date().toISOString(),
      modifiedGmt: probe?.modifiedGmt ?? null,
      renderedAt: probe?.renderedAt ?? null,
      upstreamDate: probe?.upstreamDate ?? null,
      serving: res.headers.get("x-serving-instance"),
      rendering: probe?.instance?.id ?? null,
      nextCache: res.headers.get("x-nextjs-cache"),
    };
  } catch (err) {
    return { path, at: new Date().toISOString(), error: String(err) };
  }
}

/** Several samples, because a scaled fleet answers from more than one pod. */
const probeRoute = (p) => Promise.all([sample(p), sample(p), sample(p)]);

async function publish() {
  const user = process.env.WP_USER;
  const pass = process.env.WP_APP_PASSWORD;
  if (!user || !pass) {
    log("  no WP credentials — cannot publish, run would be meaningless.");
    process.exit(1);
  }
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  const res = await fetch(`${WP_REST}/posts/${WP_POST_ID}`, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({ excerpt: `dc-drift probe ${new Date().toISOString()}` }),
  });
  const body = await res.json().catch(() => null);
  log(`  published: ${res.status} modifiedGmt=${body?.modified_gmt}`);
  return body?.modified_gmt ?? null;
}

/* ---------------------------------------------------------------------- run */

const out = { startedAt: new Date().toISOString(), base: BASE, routes: ROUTES, rounds: [] };

log(`base=${BASE} routes=${ROUTES.join(",")} window=${WINDOW_S}s poll=${POLL_MS}ms\n`);

log("=== warm (prime the Data Cache with pre-publish content)");
for (const p of ROUTES) {
  const s = (await probeRoute(p))[0];
  log(`  ${p} modified=${s.modifiedGmt} upstreamDate=${s.upstreamDate}`);
}
// The fetch entries must exist and be older than the publish, or /dcsplit would
// simply fetch the new content on its first miss and prove nothing.
await sleep(25000);

log("\n=== publish");
const expected = await publish();
await sleep(3000);

log("\n=== observe");
const state = Object.fromEntries(
  ROUTES.map((p) => [p, { renders: new Set(), upstreamDates: new Set(), versions: new Set(), freshAtMs: null }])
);
const t0 = Date.now();
while (Date.now() - t0 < WINDOW_S * 1000) {
  const elapsed = Date.now() - t0;
  const row = { elapsedMs: elapsed, routes: {} };
  for (const p of ROUTES) {
    const samples = await probeRoute(p);
    const ok = samples.filter((s) => !s.error);
    const st = state[p];
    for (const s of ok) {
      if (s.renderedAt) st.renders.add(s.renderedAt);
      if (s.upstreamDate) st.upstreamDates.add(s.upstreamDate);
      if (s.modifiedGmt) st.versions.add(s.modifiedGmt);
    }
    const fresh = ok.filter((s) => s.modifiedGmt === expected).length;
    if (fresh > 0 && st.freshAtMs === null) st.freshAtMs = elapsed;
    row.routes[p] = {
      fresh,
      n: ok.length,
      distinctRenders: st.renders.size,
      distinctUpstreamDates: st.upstreamDates.size,
      samples: ok,
    };
  }
  out.rounds.push(row);
  log(
    `  +${(elapsed / 1000).toFixed(0)}s  ` +
      ROUTES.map(
        (p) =>
          `${p} fresh=${row.routes[p].fresh}/${row.routes[p].n} ` +
          `renders=${row.routes[p].distinctRenders} upstream=${row.routes[p].distinctUpstreamDates}`
      ).join("  |  ")
  );
  await sleep(POLL_MS);
}

out.expected = expected;
out.verdict = Object.fromEntries(
  ROUTES.map((p) => {
    const st = state[p];
    return [
      p,
      {
        wentFresh: st.freshAtMs !== null,
        freshAtMs: st.freshAtMs,
        distinctRenders: st.renders.size,
        distinctUpstreamDates: st.upstreamDates.size,
        versionsSeen: [...st.versions],
        // The signature: the component ran many times, the network was used once.
        regeneratedWithoutFetching: st.renders.size > 1 && st.upstreamDates.size === 1,
      },
    ];
  })
);

out.finishedAt = new Date().toISOString();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2));

log("\n=== verdict");
for (const [p, v] of Object.entries(out.verdict)) {
  log(
    `${p.padEnd(10)} wentFresh=${v.wentFresh} (${v.freshAtMs ?? "never"}ms)  ` +
      `distinctRenders=${v.distinctRenders}  distinctUpstreamDates=${v.distinctUpstreamDates}  ` +
      `regeneratedWithoutFetching=${v.regeneratedWithoutFetching}`
  );
}
log(`\nwrote ${OUT}`);
