import type { NextApiRequest, NextApiResponse } from "next";
import { revalidateTag } from "next/cache";
import { checkSecret, serializeError } from "../../lib/api-shared";
import { INSTANCE } from "../../lib/instance";

// Next 16 requires the second argument. `{ expire: 0 }` means "stale now".
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!checkSecret(req, res)) return;
  const tag = typeof req.query.tag === "string" ? req.query.tag : "content";
  try {
    revalidateTag(tag, { expire: 0 });
    return res.status(200).json({ ok: true, method: "revalidateTag", tag, instance: INSTANCE });
  } catch (err) {
    return res.status(200).json({
      ok: false, method: "revalidateTag", tag, instance: INSTANCE, error: serializeError(err),
    });
  }
}
