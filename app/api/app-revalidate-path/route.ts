import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { INSTANCE } from "../../../lib/instance";
import { serializeError } from "../../../lib/api-shared";

/**
 * Closes the question RESULTS.md §8 left open.
 *
 * revalidatePath() threw E263 from a pages/api handler because there is no App
 * Router work store there. A Route Handler DOES have one, so if this succeeds,
 * the WP Engine doc's "revalidatePath/revalidateTag are not compatible" is
 * about Atlas's ISR store, not about upstream Next. That distinction decides
 * whether the customer has a supported App-Router-native option at all, and it
 * is precisely the claim I declined to assert without evidence.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== process.env.REVALIDATE_SECRET) {
    return NextResponse.json({ ok: false, error: "invalid secret" }, { status: 401 });
  }
  const path = url.searchParams.get("path") ?? "/rh";
  try {
    revalidatePath(path);
    return NextResponse.json({
      ok: true, router: "app", method: "revalidatePath", path, instance: INSTANCE,
      at: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({
      ok: false, router: "app", method: "revalidatePath", path, instance: INSTANCE,
      error: serializeError(err),
    });
  }
}

export const GET = POST;
