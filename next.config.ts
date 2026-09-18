import type { NextConfig } from "next";
import { withWPEConfig } from "@wpengine/atlas-next";

const nextConfig: NextConfig = {
  // Cache Components must stay OFF. Enabling it removes the `revalidate` and
  // `dynamic` route segment configs this whole harness is built on, and the
  // customer is on the legacy caching model.

  /**
   * `Cache-Tag` is what makes purgeTags() work. The edge records these tags
   * against the cached response, and a later purgeTags(['post-3267']) drops
   * every response carrying that tag.
   *
   * This is the mechanism the customer actually wants: a WordPress save_post
   * hook knows the post ID but not which routes render that post. Tagging by
   * content lets one purge call invalidate all of them without maintaining a
   * post-ID-to-paths map in PHP.
   *
   * `post-3267` is deliberately applied to several routes so the test can show
   * one call purging many pages. Per-route tags are included so cells can be
   * isolated from each other.
   *
   * Note: these headers are not visible in browser devtools by design, so the
   * only way to confirm they landed is to purge by tag and observe the effect.
   */
  async headers() {
    return [
      { source: "/a", headers: [{ key: "Cache-Tag", value: "post-3267,route-a" }] },
      { source: "/c", headers: [{ key: "Cache-Tag", value: "post-3267,route-c" }] },
      { source: "/e", headers: [{ key: "Cache-Tag", value: "post-3267,route-e" }] },
      { source: "/rh", headers: [{ key: "Cache-Tag", value: "post-3267,route-rh" }] },
      { source: "/rt", headers: [{ key: "Cache-Tag", value: "post-3267,route-rt" }] },
    ];
  },
};

export default withWPEConfig(nextConfig);
