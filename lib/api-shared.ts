import type { NextApiRequest, NextApiResponse } from "next";

export function checkSecret(req: NextApiRequest, res: NextApiResponse) {
  const expected = process.env.REVALIDATE_SECRET;
  if (!expected) {
    res.status(500).json({ ok: false, error: "REVALIDATE_SECRET is not set" });
    return false;
  }
  if (req.query.secret !== expected) {
    res.status(401).json({ ok: false, error: "invalid secret" });
    return false;
  }
  return true;
}

/**
 * A throw is itself a result worth recording, and the __NEXT_ERROR_CODE is the
 * most citable part of it — so serialize rather than crash.
 */
export function serializeError(err: unknown) {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      code: (err as Error & { __NEXT_ERROR_CODE?: string }).__NEXT_ERROR_CODE ?? null,
      stack: err.stack?.split("\n").slice(0, 6).join("\n") ?? null,
    };
  }
  return { name: "non-error-throw", message: String(err), code: null, stack: null };
}
