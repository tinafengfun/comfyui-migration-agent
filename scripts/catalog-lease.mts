#!/usr/bin/env node
/**
 * catalog-lease.mts — deterministic CLI for the per-nodeKey migration clone-lease,
 * so the Step 05 agent takes/releases the PESSIMISTIC lock around the shared-tree
 * clone without opening SQLite or talking git itself. Thin wrapper over
 * xpuCatalogClient.acquireLease/heartbeatLease/releaseLease (→ the one catalog-server).
 *
 * Usage:
 *   npx tsx scripts/catalog-lease.mts --node-key <k> --action acquire  --holder <id> [--ttl 600]
 *   npx tsx scripts/catalog-lease.mts --node-key <k> --action heartbeat --lease-id <id> [--ttl 600]
 *   npx tsx scripts/catalog-lease.mts --node-key <k> --action release  --lease-id <id>
 *
 * Exit codes: acquire → 0 granted / 3 held-by-other (agent WAITS + reuses);
 * heartbeat/release → 0 ok / 1 not-ours; bad args → 2.
 */
import { acquireLease, heartbeatLease, releaseLease } from "../src/server/xpuCatalogClient";
import { parseLeaseArgs } from "../src/server/catalogCliArgs";

async function main(): Promise<number> {
  const a = parseLeaseArgs(process.argv.slice(2));
  if (!a.nodeKey || !a.action) {
    console.error("usage: --node-key <k> --action acquire|heartbeat|release [--holder --ttl --lease-id]");
    return 2;
  }
  if (a.action === "acquire") {
    const r = await acquireLease(a.nodeKey, a.holder ?? "agent", a.ttlSec);
    console.log(JSON.stringify(r));
    return r.granted ? 0 : 3;
  }
  if (a.action === "heartbeat") {
    if (!a.leaseId) return 2;
    const ok = await heartbeatLease(a.nodeKey, a.leaseId, a.ttlSec);
    console.log(JSON.stringify({ ok }));
    return ok ? 0 : 1;
  }
  if (a.action === "release") {
    if (!a.leaseId) return 2;
    const ok = await releaseLease(a.nodeKey, a.leaseId);
    console.log(JSON.stringify({ released: ok }));
    return ok ? 0 : 1;
  }
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
