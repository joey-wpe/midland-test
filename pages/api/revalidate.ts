import type { NextApiRequest, NextApiResponse } from "next";
import { checkSecret, serializeError } from "../../lib/api-shared";
import { INSTANCE } from "../../lib/instance";

/**
 * The mechanism under test: res.revalidate() from a pages/api handler against
 * an App Router path. Locally this invalidated BOTH the Full Route Cache and
 * the Data Cache. The open question is whether that survives Atlas — where the
 * cache handler is swapped and the process is one replica of several.
 *
 * Always echoes the instance that handled the purge, because on Atlas the
 * purge lands on exactly one replica and that is the crux of the whole test.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!checkSecret(req, res)) return;
  const path = typeof req.query.path === "string" ? req.query.path : "/a";
  const startedAt = new Date().toISOString();
  try {
    await res.revalidate(path);
    return res.status(200).json({
      ok: true, method: "res.revalidate", path,
      instance: INSTANCE, startedAt, finishedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(200).json({
      ok: false, method: "res.revalidate", path,
      instance: INSTANCE, startedAt, finishedAt: new Date().toISOString(),
      error: serializeError(err),
    });
  }
}
