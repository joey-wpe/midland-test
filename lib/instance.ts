import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

/**
 * Identifies the Node process that answered a request.
 *
 * On Atlas the app runs behind a load balancer across N replicas, and the whole
 * point of this harness is to tell those replicas apart. Stashed on globalThis
 * rather than at module scope because Next bundles `app/` and `pages/`
 * separately — module-scope state would give the two routers different IDs
 * inside the same process, which is exactly the false positive we cannot afford.
 */
type Instance = {
  id: string;
  host: string;
  pid: number;
  bootedAt: string;
};

const g = globalThis as typeof globalThis & { __ATLAS_INSTANCE?: Instance };

g.__ATLAS_INSTANCE ??= {
  id: randomUUID().slice(0, 8),
  host: hostname(),
  pid: process.pid,
  bootedAt: new Date().toISOString(),
};

export const INSTANCE = g.__ATLAS_INSTANCE;

/**
 * Whether the @wpengine/atlas-next shared KV cache is even wired up in this
 * environment. Read straight from the env names the package's cache handler
 * looks at. Tokens are never echoed — only presence.
 */
export function kvStoreStatus() {
  const rollout = process.env.HEADLESS_CACHE_HANDLER_ROLLOUT_PERCENT ?? null;
  return {
    kvUrlPresent: Boolean(process.env.HEADLESS_KV_STORE_URL),
    kvTokenPresent: Boolean(process.env.HEADLESS_KV_STORE_TOKEN),
    rolloutPercent: rollout,
    buildId: process.env.HEADLESS_METADATA_BUILD_ID ?? null,
    debug: process.env.HEADLESS_CACHE_HANDLER_DEBUG ?? process.env.ATLAS_CACHE_HANDLER_DEBUG ?? null,
  };
}
