#!/usr/bin/env node
// Reference KT auditor CLI (spec/key-transparency.md § Reference auditor).
//
// Independently verifies a relay's published key-transparency log using only
// its public endpoints — no trust in, or cooperation from, the operator.
//
//   node dist/ktAuditCli.js <relay-base-url> [--watch] [--interval=<sec>] [--max-gap-hours=<h>]
//   # dev: npm run kt-audit -w server -- http://localhost:8080
//
// One-shot: fetch identity key + all signed roots, verify signatures + hash
// chain, print the result, exit non-zero on failure. Watch mode: poll on an
// interval, persist seen roots in memory, and alarm on a rewrite (a prior
// epoch's rootHash changed) or a stall (no fresh heartbeat epoch within the
// gap). See ktAudit.ts for the verification core and its current limits
// (cryptographic consistency proofs await the AKD structure).

import {
  detectRewrite,
  detectStall,
  keysFromDelegations,
  verifyRootChain,
  type RootSigningKeys,
  type SignedRoot,
} from './ktAudit.js';

interface Args {
  base: string;
  watch: boolean;
  intervalMs: number;
  maxGapMs: number;
}

function parseArgs(argv: string[]): Args {
  const rest = argv.slice(2);
  const base = rest.find((a) => !a.startsWith('--'));
  if (!base) {
    console.error('usage: kt-audit <relay-base-url> [--watch] [--interval=<sec>] [--max-gap-hours=<h>]');
    process.exit(2);
  }
  const num = (flag: string, dflt: number): number => {
    const hit = rest.find((a) => a.startsWith(`--${flag}=`));
    const v = hit ? Number(hit.split('=')[1]) : NaN;
    return Number.isFinite(v) ? v : dflt;
  };
  return {
    base: base.replace(/\/$/, ''),
    watch: rest.includes('--watch'),
    intervalMs: num('interval', 300) * 1000,
    maxGapMs: num('max-gap-hours', 24) * 60 * 60_000,
  };
}

/**
 * `identityPubKey` is the relay's ROOT key (the one clients pin); the keys that
 * actually sign roots are named by root-signed delegations. `keys` is null when
 * that chain doesn't verify — which is itself an audit failure, not a fetch
 * problem, so it is reported rather than thrown.
 */
async function fetchLog(base: string): Promise<{ keys: RootSigningKeys | null; roots: SignedRoot[] }> {
  const info = (await (await fetch(`${base}/api/relay/info`)).json()) as {
    identityPubKey: string;
    delegations?: unknown[];
  };
  const rootsBody = (await (await fetch(`${base}/api/relay/kt/roots`)).json()) as { roots: SignedRoot[] };
  return {
    keys: keysFromDelegations(info.identityPubKey, info.delegations ?? []),
    roots: rootsBody.roots,
  };
}

/** One verification pass; returns false on any failure so callers can exit. */
function report(keys: RootSigningKeys | null, roots: SignedRoot[], maxGapMs: number): boolean {
  if (!keys) {
    console.error("✗ the relay's delegation chain does not verify against its own root key");
    return false;
  }
  const chain = verifyRootChain(keys, roots);
  const latestTs = roots.reduce<number | undefined>((m, r) => Math.max(m ?? 0, r.timestamp ?? 0) || m, undefined);
  const stalled = detectStall(latestTs, Date.now(), maxGapMs);
  if (!chain.ok) {
    console.error(`✗ chain invalid: ${chain.error} (verified ${chain.verifiedEpochs} epoch(s))`);
    return false;
  }
  if (stalled) {
    console.error(`✗ log stalled: newest epoch older than the heartbeat gap`);
    return false;
  }
  console.log(`✓ ${chain.verifiedEpochs} epoch(s) verified — signatures + hash chain intact`);
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const { keys, roots } = await fetchLog(args.base);

  if (!args.watch) {
    process.exit(report(keys, roots, args.maxGapMs) ? 0 : 1);
  }

  const seen = new Map<number, string>(roots.map((r) => [r.epoch, r.rootHash]));
  report(keys, roots, args.maxGapMs);
  console.log(`watching ${args.base} every ${args.intervalMs / 1000}s …`);
  setInterval(() => {
    void (async () => {
      try {
        const fresh = await fetchLog(args.base);
        const rewrite = detectRewrite(seen, fresh.roots);
        if (rewrite) {
          console.error(`✗ REWRITE: epoch ${rewrite.epoch} changed ${rewrite.was} → ${rewrite.now}`);
          return;
        }
        for (const r of fresh.roots) seen.set(r.epoch, r.rootHash);
        report(fresh.keys, fresh.roots, args.maxGapMs);
      } catch (e) {
        console.error(`poll failed: ${(e as Error).message}`);
      }
    })();
  }, args.intervalMs);
}

void main();
