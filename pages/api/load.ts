import type { NextApiRequest, NextApiResponse } from "next";
import { INSTANCE } from "../../lib/instance";

/**
 * Concurrency ballast for the divergence test.
 *
 * Atlas autoscales on in-flight concurrency, so holding several replicas alive
 * requires requests that stay open — not merely a lot of them. The obvious
 * candidate was /control, but it does a real WPGraphQL round trip, which would
 * pour ~66 req/s into WordPress for the duration of a matrix run.
 *
 * This does the same job by sleeping instead: slow enough that a modest number
 * of workers holds high concurrency, with zero upstream load. Deliberately
 * unauthenticated (it exposes nothing and grants nothing) but capped at 2s so
 * it cannot be used to pin the fleet open indefinitely.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ms = Math.min(Number(req.query.ms ?? 800) || 800, 2000);
  await new Promise((r) => setTimeout(r, ms));
  res.setHeader("cache-control", "no-store, max-age=0");
  res.status(200).json({ ok: true, sleptMs: ms, instance: INSTANCE });
}
