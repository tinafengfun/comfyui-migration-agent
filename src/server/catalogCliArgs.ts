/**
 * Arg parsers for the catalog CLIs (`scripts/catalog-lease.mts`,
 * `scripts/catalog-explore.mts`). Kept in a .ts lib so tsc + vitest can import
 * them (a `.mts` script path can't be imported under our tsconfig).
 */
import { MAX_EXPLORE_ROUNDS } from "./exploreBudget";

export interface LeaseArgs {
  action: "acquire" | "heartbeat" | "release" | "";
  nodeKey?: string;
  holder?: string;
  ttlSec: number;
  leaseId?: string;
}

export function parseLeaseArgs(argv: string[]): LeaseArgs {
  const out: LeaseArgs = { action: "", ttlSec: 600 };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--action": out.action = (next() ?? "") as LeaseArgs["action"]; break;
      case "--node-key": out.nodeKey = next(); break;
      case "--holder": out.holder = next(); break;
      case "--ttl": out.ttlSec = Number(next() ?? 600); break;
      case "--lease-id": out.leaseId = next(); break;
    }
  }
  return out;
}

export interface ExploreArgs {
  action: "record" | "status" | "";
  artifactPath?: string;
  nodeKey?: string;
  max: number;
}

export function parseExploreArgs(argv: string[]): ExploreArgs {
  const out: ExploreArgs = { action: "", max: MAX_EXPLORE_ROUNDS };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--action": out.action = (next() ?? "") as ExploreArgs["action"]; break;
      case "--workspace": out.artifactPath = next(); break;
      case "--node-key": out.nodeKey = next(); break;
      case "--max": out.max = Number(next() ?? MAX_EXPLORE_ROUNDS); break;
    }
  }
  return out;
}
