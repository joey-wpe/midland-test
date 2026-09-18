import { NextResponse } from "next/server";
import { INSTANCE } from "./lib/instance";

/**
 * Stamps the pod that SERVED the response.
 *
 * Every page already embeds the pod that RENDERED it, but until now the two
 * could not be compared: a round of samples collapsing to one rendering pod was
 * only evidence of sharing if you also believed the load balancer had spread
 * those samples. That inference held up, but it is an inference.
 *
 * With this header the claim becomes direct. `x-serving-instance` != the
 * `instance.id` inside the HTML means that pod returned a render it did not
 * perform, which is only possible if it read the entry from shared storage.
 *
 * Node runtime, not edge: the edge runtime is a separate isolate and would mint
 * its own INSTANCE, making the comparison meaningless. Node runtime shares the
 * server process, and lib/instance.ts stashes on globalThis for exactly this
 * kind of cross-bundle identity.
 */
export const config = {
  runtime: "nodejs",
  // Pages only. API routes already report their instance in the JSON body, and
  // excluding _next/static keeps this off the asset path.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

export function middleware() {
  const res = NextResponse.next();
  res.headers.set("x-serving-instance", INSTANCE.id);
  res.headers.set("x-serving-host", INSTANCE.host);
  return res;
}
