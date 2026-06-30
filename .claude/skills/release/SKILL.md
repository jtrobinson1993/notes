---
name: release
description: Use when cutting/publishing a new release of this app — bumping the version, merging via PR, tagging, and shipping the GHCR image. Covers the full flow the maintainer asks for ("commit, push, merge if CI green, tag a new version, push the tag, publish the image").
---

# Cutting a release

A release is just a **version tag** on `main`: pushing `vX.Y.Z` triggers
`.github/workflows/release.yml`, which builds the multi-arch image and pushes it
to GHCR (`ghcr.io/<owner>/<repo>:X.Y.Z` + `:latest`). The production box only
ever `docker compose pull && up -d` — it never builds.

## The one rule: the tag is tied to `package.json`

The version lives in the **root `package.json`**. A tag must be exactly
`v<root package.json version>`. `release.yml` has a guard step that **fails the
release if they don't match**, so never tag a commit whose version wasn't
bumped. Bump `package.json` → that bump rides through a PR onto `main` → tag
that commit. The two move together.

## Steps

Assumes the change is on a feature branch (never commit to protected `main`).

1. **Green locally.** `npm test` and `npm run typecheck` must pass; working tree
   otherwise clean.

2. **Bump the version** (no git tag yet — the tag comes after the merge):

   ```sh
   npm version patch --no-git-tag-version   # minor / major when warranted
   ```

   This updates `package.json` **and** `package-lock.json`. Don't bump the
   workspace sub-packages — the app version is the root one.

3. **Commit** the work + the bump, **push**, and open a PR:

   ```sh
   git add -A && git commit   # include the version bump in the release PR
   git push -u origin HEAD
   gh pr create --fill
   ```

4. **Wait for CI green, then merge.** CI = `unit` (Vitest + coverage gates),
   `e2e` (Playwright), `image-boot` (the pruned prod image boots). Watch it:

   ```sh
   gh pr checks --watch
   gh pr merge --merge --delete-branch   # only after all checks pass
   ```

5. **Update local `main`:**

   ```sh
   git fetch origin && git checkout main && git merge --ff-only origin/main
   ```

6. **Tag and push** (tag value comes straight from `package.json`, so it can't
   drift from the guard):

   ```sh
   TAG="v$(node -p "require('./package.json').version")"
   git tag "$TAG" && git push origin "$TAG"
   ```

7. **Watch the image publish.** The tag push starts the `Release` workflow:

   ```sh
   gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId')"
   ```

   On success the image is at `ghcr.io/<owner>/<repo>:<version>` and `:latest`.
   Confirm with `gh release`/the GHCR package list, then report the published
   tag back to the maintainer.

8. **Sync `main` and clean up.** Pull the latest into local `main` once more (it
   may have moved since step 5), then tear down the worktree/branch the release
   was cut from so nothing stale lingers:

   ```sh
   git checkout main && git fetch origin && git merge --ff-only origin/main

   # if the release was cut from a git worktree, remove it (run from main repo,
   # not from inside the worktree dir), then delete the merged feature branch:
   git worktree remove <worktree-path>   # skip if not a worktree
   git branch -d <feature-branch>        # -d only deletes if fully merged
   git worktree prune                    # drop any stale worktree metadata
   ```

   `git branch -d` (not `-D`) is deliberate: it refuses to delete a branch that
   isn't fully merged, so it doubles as a guard that the release really landed.

## Notes

- **Protected `main`:** the version bump can't be a direct commit — it rides in
  the release PR (or its own `chore(release): vX.Y.Z` PR).
- **Don't re-tag.** If a tag was wrong, delete it locally + on origin
  (`git push origin :vX.Y.Z`) before pushing a corrected one; a re-pushed
  existing tag won't re-trigger cleanly.
