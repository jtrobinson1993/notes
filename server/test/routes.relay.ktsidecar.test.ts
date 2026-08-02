import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { enrollDevice as enrollRelayDevice, makeRelayApp, seedUser, type TestApp } from '../../test/helpers/server.js';

let ctx: TestApp;
let sidecar: Server | undefined;
afterEach(async () => {
  if (ctx) await ctx.cleanup();
  if (sidecar) await new Promise((r) => sidecar!.close(() => r(null)));
  sidecar = undefined;
});

interface SidecarState {
  published: { handle: string; key: string }[][];
  publishAuth: string | undefined;
  root: string;
}

/** A stand-in for akd-sidecar: records publishes, serves a fixed proof/root. */
function fakeSidecar(): Promise<{ url: string; state: SidecarState }> {
  const state: SidecarState = { published: [], publishAuth: undefined, root: Buffer.alloc(32, 3).toString('base64') };
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/publish') {
        state.publishAuth = req.headers.authorization;
        state.published.push(JSON.parse(body).entries);
        res.end(JSON.stringify({ epoch: state.published.length, root: state.root }));
      } else if (req.url?.startsWith('/lookup/')) {
        res.end(JSON.stringify({ proof: { akd: 'lookup-proof' }, epoch: 1, root: state.root }));
      } else if (req.url?.startsWith('/key-history/')) {
        res.end(JSON.stringify({ proof: { akd: 'history-proof' }, epoch: 1, root: state.root }));
      } else if (req.url === '/vrf-public-key') {
        res.end(JSON.stringify({ key: Buffer.alloc(32, 9).toString('base64') }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  sidecar = srv;
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, state });
    });
  });
}

async function deviceBearer(userId: string): Promise<string> {
  const { token } = await enrollRelayDevice(ctx.app, ctx.db, { userId });
  return token; // raw token; call sites add the `Bearer ` prefix
}

const KEY = Buffer.alloc(32, 1).toString('base64');

describe('relay ↔ akd KT sidecar integration', () => {
  it('publishes directory updates to the sidecar and serves its akd proof', async () => {
    const { url, state } = await fakeSidecar();
    ctx = await makeRelayApp({ akdSidecarUrl: url, akdSidecarToken: 'sc-secret' });
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);

    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/relay/directory',
      headers: { authorization: `Bearer ${bearer}` },
      payload: { identityPubKey: KEY, sealingPubKey: Buffer.alloc(32, 2).toString('base64') },
    });
    expect(put.statusCode).toBe(200);
    // The relay published this handle→key to the sidecar, with the shared bearer.
    expect(state.published).toEqual([[{ handle: 'Alice#0001', key: KEY }]]);
    expect(state.publishAuth).toBe('Bearer sc-secret');

    const look = await ctx.app.inject({ method: 'GET', url: '/api/relay/directory/Alice%230001' });
    expect(look.statusCode).toBe(200);
    const body = look.json();
    expect(body.kt).toBe('akd');
    expect(body.proof).toEqual({ akd: 'lookup-proof' }); // the sidecar's proof, passed through
    expect(body.rootHash).toBe(state.root);
    expect(body.vrfPublicKey).toBe(Buffer.alloc(32, 9).toString('base64'));
    expect(body.identityPubKey).toBe(KEY); // identity/sealing still come from the relay directory

    // The akd root is signed + chained into the KT roots log for auditors.
    const roots = (await ctx.app.inject({ method: 'GET', url: '/api/relay/kt/roots' })).json().roots as { rootHash: string }[];
    expect(roots.at(-1)?.rootHash).toBe(state.root);
  });

  it('serves the sidecar key-history proof for self-audit (404 without a sidecar)', async () => {
    const { url } = await fakeSidecar();
    ctx = await makeRelayApp({ akdSidecarUrl: url, akdSidecarToken: 'sc-secret' });
    const hist = await ctx.app.inject({ method: 'GET', url: '/api/relay/directory/Alice%230001/history' });
    expect(hist.statusCode).toBe(200);
    const body = hist.json();
    expect(body.proof).toEqual({ akd: 'history-proof' });
    expect(body.vrfPublicKey).toBe(Buffer.alloc(32, 9).toString('base64'));

    // No sidecar → the interim KT has no history.
    const noCtx = await makeRelayApp();
    const noHist = await noCtx.app.inject({ method: 'GET', url: '/api/relay/directory/Alice%230001/history' });
    expect(noHist.statusCode).toBe(404);
    await noCtx.cleanup();
  });

  it('without a sidecar configured, the interim Merkle KT still serves', async () => {
    ctx = await makeRelayApp(); // no akdSidecarUrl
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/relay/directory',
      headers: { authorization: `Bearer ${bearer}` },
      payload: { identityPubKey: KEY, sealingPubKey: Buffer.alloc(32, 2).toString('base64') },
    });
    const look = await ctx.app.inject({ method: 'GET', url: '/api/relay/directory/Alice%230001' });
    const body = look.json();
    expect(body.kt).toBeUndefined(); // interim path
    expect(Array.isArray(body.proof)).toBe(true); // Merkle inclusion path, not an akd proof object
  });
});
