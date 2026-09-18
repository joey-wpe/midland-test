import Link from "next/link";
import { INSTANCE, kvStoreStatus } from "../lib/instance";

// Index. force-dynamic so it always reports the serving replica honestly.
export const dynamic = "force-dynamic";

const ROUTES = ["/a", "/c", "/e", "/rh", "/rt", "/control"];

export default function Page() {
  return (
    <main>
      <h1>atlas-revalidate-wpe</h1>
      <pre id="probe">{JSON.stringify({ instance: INSTANCE, kv: kvStoreStatus() }, null, 2)}</pre>
      <ul>
        {ROUTES.map((r) => (
          <li key={r}>
            <Link href={r}>{r}</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
