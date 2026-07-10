// Client for the v8 key-transparency sidecar (akd-sidecar). When AKD_SIDECAR_URL
// is configured the relay drives full-AKD KT through this — publish on directory
// update, VRF-blinded akd inclusion proofs on lookup — instead of the interim
// Merkle KT. Calls are localhost-only and carry the shared AKD_SIDECAR_TOKEN
// bearer. The VRF public key is cached (it's stable for the directory's life).

export interface KtLookup {
  /** serde-serialized akd `LookupProof` (opaque here; the client verifies it). */
  proof: unknown;
  epoch: number;
  /** base64 akd root the proof + signature are checked against. */
  root: string;
}

export interface KtSidecar {
  /** Publish `handle → identity-key` bindings as a new epoch → (epoch, root). */
  publish(entries: { handle: string; key: string }[]): Promise<{ epoch: number; root: string }>;
  /** A VRF-blinded inclusion proof for a handle, or `null` if not present. */
  lookup(handle: string): Promise<KtLookup | null>;
  /** A key-history proof for a handle (self-audit), or `null` if not present. */
  keyHistory(handle: string): Promise<KtLookup | null>;
  /** base64 VRF public key clients verify blinded labels against (cached). */
  vrfPublicKey(): Promise<string>;
}

export function createKtSidecar(url: string, token: string): KtSidecar {
  const base = url.replace(/\/$/, '');
  const auth = { authorization: `Bearer ${token}` };
  let vrfCache: string | null = null;

  return {
    async publish(entries) {
      const res = await fetch(`${base}/publish`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ entries }),
      });
      if (!res.ok) throw new Error(`kt sidecar publish failed (${res.status})`);
      return (await res.json()) as { epoch: number; root: string };
    },
    async lookup(handle) {
      const res = await fetch(`${base}/lookup/${encodeURIComponent(handle)}`, { headers: auth });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`kt sidecar lookup failed (${res.status})`);
      return (await res.json()) as KtLookup;
    },
    async keyHistory(handle) {
      const res = await fetch(`${base}/key-history/${encodeURIComponent(handle)}`, { headers: auth });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`kt sidecar key-history failed (${res.status})`);
      return (await res.json()) as KtLookup;
    },
    async vrfPublicKey() {
      if (vrfCache) return vrfCache;
      const res = await fetch(`${base}/vrf-public-key`, { headers: auth });
      if (!res.ok) throw new Error(`kt sidecar vrf-key failed (${res.status})`);
      vrfCache = ((await res.json()) as { key: string }).key;
      return vrfCache;
    },
  };
}
