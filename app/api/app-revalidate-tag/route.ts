import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { INSTANCE } from "../../../lib/instance";
import { serializeError } from "../../../lib/api-shared";

/**
 * Tag invalidation from a context that has a work store. Also the probe for
 * atlas-next's cache handler, whose revalidateTag delegates only to the
 * filesystem cache and never reaches the shared KV store — meaning a tag purge
 * should be visible on the replica that handled it and on no other.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== process.env.REVALIDATE_SECRET) {
    return NextResponse.json({ ok: false, error: "invalid secret" }, { status: 401 });
  }
  const tag = url.searchParams.get("tag") ?? "rt-content";
  try {
    revalidateTag(tag, { expire: 0 });
    return NextResponse.json({
      ok: true, router: "app", method: "revalidateTag", tag, instance: INSTANCE,
      at: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({
      ok: false, router: "app", method: "revalidateTag", tag, instance: INSTANCE,
      error: serializeError(err),
    });
  }
}

export const GET = POST;
