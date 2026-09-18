import type { NextApiRequest, NextApiResponse } from "next";
import { checkSecret, serializeError } from "../../lib/api-shared";
import { INSTANCE } from "../../lib/instance";

/**
 * Atlas's edge cache sits in front of the Node replicas, so it is a *separate*
 * cache layer from anything res.revalidate() touches.
 *
 * Reading @wpengine/atlas-next's dist source (RESULTS.md §11c), the handler's
 * post-revalidation edge purge only fires for CachedRouteKind.PAGES — i.e.
 * Pages Router. If that holds, an App Router on-demand revalidation writes
 * fresh content into the ISR store but never purges the edge, and pairing with
 * @wpengine/edge-cache stops being an optimisation and becomes mandatory.
 * This endpoint is how we test that claim on real infrastructure.
 *
 * Imported dynamically so a missing/unavailable package degrades to a recorded
 * error instead of failing the build.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!checkSecret(req, res)) return;
  const paths = String(req.query.paths ?? "/a")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  try {
    const mod: Record<string, unknown> = await import("@wpengine/edge-cache");
    const purgePaths = mod.purgePaths as ((p: string[]) => Promise<unknown>) | undefined;
    if (typeof purgePaths !== "function") {
      return res.status(200).json({
        ok: false, method: "purgePaths", paths, instance: INSTANCE,
        error: { message: "purgePaths not exported", exports: Object.keys(mod) },
      });
    }
    const result = await purgePaths(paths);
    return res.status(200).json({ ok: true, method: "purgePaths", paths, instance: INSTANCE, result });
  } catch (err) {
    return res.status(200).json({
      ok: false, method: "purgePaths", paths, instance: INSTANCE, error: serializeError(err),
    });
  }
}
