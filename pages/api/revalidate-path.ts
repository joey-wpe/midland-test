import type { NextApiRequest, NextApiResponse } from "next";
import { revalidatePath } from "next/cache";
import { checkSecret, serializeError } from "../../lib/api-shared";
import { INSTANCE } from "../../lib/instance";

// Expected to throw E263 (static generation store missing) — a pages/api
// handler has no App Router work store. Kept so the Atlas run can confirm the
// local result rather than assume it. See app/api/revalidate-path for the
// variant that DOES have a work store.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!checkSecret(req, res)) return;
  const path = typeof req.query.path === "string" ? req.query.path : "/a";
  try {
    revalidatePath(path);
    return res.status(200).json({ ok: true, method: "revalidatePath", path, instance: INSTANCE });
  } catch (err) {
    return res.status(200).json({
      ok: false, method: "revalidatePath", path, instance: INSTANCE, error: serializeError(err),
    });
  }
}
