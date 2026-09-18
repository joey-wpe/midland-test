import type { NextConfig } from "next";
import { withWPEConfig } from "@wpengine/atlas-next";

const nextConfig: NextConfig = {
  // Cache Components must stay OFF. Enabling it removes the `revalidate` and
  // `dynamic` route segment configs this whole harness is built on, and the
  // customer is on the legacy caching model.
};

export default withWPEConfig(nextConfig);
