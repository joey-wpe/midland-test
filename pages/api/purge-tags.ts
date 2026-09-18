import type { NextApiRequest, NextApiResponse } from "next";
import { checkSecret, serializeError } from "../../lib/api-shared";
import { INSTANCE } from "../../lib/instance";

/**
 * Edge purge by Cache-Tag.
 *
 * This is the shape that actually fits the customer's problem. A save_post hook
 * knows a post ID; it does not know which routes render that post. purgePaths
 * would force them to maintain a post-ID-to-paths map in PHP and keep it in
 * sync with their Next routing. purgeTags lets WordPress say "post 3267
 * changed" and have the edge work out which cached responses that affects.
 *
 * Caps documented by WP Engine: 30 tags per call, 300 purge operations per hour
 * per environment. Batching many tags into one call still counts as one
 * operation, so batching is the right instinct under the hourly cap.
 *
 * Off-platform this logs instead of purging, so a local 200 means nothing.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!checkSecret(req, res)) return;
  const tags = String(req.query.tags ?? "post-3267")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (tags.length > 30) {
    return res.status(400).json({ ok: false, error: `${tags.length} tags exceeds the 30-per-call cap` });
  }

  try {
    const mod: Record<string, unknown> = await import("@wpengine/edge-cache");
    const purgeTags = mod.purgeTags as ((t: string[]) => Promise<unknown>) | undefined;
    if (typeof purgeTags !== "function") {
      return res.status(200).json({
        ok: false, method: "purgeTags", tags, instance: INSTANCE,
        error: { message: "purgeTags not exported", exports: Object.keys(mod) },
      });
    }
    const result = await purgeTags(tags);
    return res.status(200).json({ ok: true, method: "purgeTags", tags, instance: INSTANCE, result });
  } catch (err) {
    return res.status(200).json({
      ok: false, method: "purgeTags", tags, instance: INSTANCE, error: serializeError(err),
    });
  }
}
