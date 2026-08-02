#!/usr/bin/env node
// Launcher for the relay operator CLI, so that ONE documented command —
// `npm run relay -- <command>` — works in both places an operator runs it:
//
//   • from a git checkout: run the TypeScript SOURCE through tsx (a
//     devDependency, so it is there). Source wins over `server/dist` on
//     purpose — a checkout's dist is frequently stale, and silently running an
//     old build of a key-management command is the last thing anyone wants.
//   • inside the published Docker image, where devDependencies and `src/` are
//     pruned away but `server/dist` is exactly what shipped: run the built JS.
//
// This matters because `init-identity` is meant to run on the operator's own
// machine, and an operator who deploys from the image has no checkout at all:
//
//   docker run --rm -v "$PWD:/out" ghcr.io/.../notes \
//     npm run relay -- init-identity --out /out/relay-identity.json
//
// (Mount a directory and pass --out; do NOT add `-w /out`. The workdir has to
// stay /app, where package.json lives, or `npm run` exits before reaching this
// launcher. Same form as README "The relay identity" and DEPLOY.md step 0.)
//
// Without this, that command would fail in the image and the documented setup
// would split into two divergent flows. stdio is inherited so `rotate-online-key`
// can still read the root private key from stdin, and the child's exit code is
// this process's exit code.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, '..');
const args = process.argv.slice(2);

const source = join(server, 'src', 'relay-cli.ts');
const built = join(server, 'dist', 'relay-cli.js');
// npm workspaces hoist to the root, but a local install is possible too.
const tsx = [join(server, 'node_modules/.bin/tsx'), join(server, '..', 'node_modules/.bin/tsx')].find((p) =>
  existsSync(p),
);

let child;
if (existsSync(source) && tsx) {
  child = spawnSync(process.execPath, [tsx, source, ...args], { stdio: 'inherit' });
} else if (existsSync(built)) {
  child = spawnSync(process.execPath, [built, ...args], { stdio: 'inherit' });
} else {
  process.stderr.write(
    'Cannot run the relay CLI: no server/src (with tsx) and no server/dist.\n' +
      'From a checkout, run `npm install` first; in the image this is a packaging bug.\n',
  );
  process.exit(1);
}

if (child.error) {
  process.stderr.write(`Could not start the relay CLI: ${child.error.message}\n`);
  process.exit(1);
}
process.exit(child.status ?? 1);
