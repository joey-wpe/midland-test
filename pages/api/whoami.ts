import type { NextApiRequest, NextApiResponse } from "next";
import { INSTANCE, kvStoreStatus } from "../../lib/instance";

/**
 * Names the replica that SERVED this request, and reports whether the
 * atlas-next shared KV cache is wired up here.
 *
 * Hammer it to count replicas behind the load balancer. Pair that count with
 * the `instance` embedded in each page's probe — which names the replica that
 * RENDERED the HTML — and divergence becomes directly observable: if the ISR
 * store were shared, every replica would serve HTML stamped with the same
 * rendering instance and the same modifiedGmt.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("cache-control", "no-store, max-age=0");
  res.setHeader("x-instance-id", INSTANCE.id);
  res.status(200).json({
    ok: true,
    instance: INSTANCE,
    uptimeSeconds: Math.round(process.uptime()),
    kv: kvStoreStatus(),
    now: new Date().toISOString(),
  });
}
