# Contributing

## Develop

```bash
npm ci
npm run typecheck
npm test
```

Load the checkout in Pi with `pi -e /path/to/pi-snap-compact` or `pi install /path/to/pi-snap-compact`, then drive a
session until compaction triggers (or run `/compact` without instructions) and verify the `[snapcompact]` header and
footer status appear.

## The `check` gate

`npm run check` runs, in order:

- `typecheck` — `tsc --noEmit`.
- `test` — Node's test runner over `test/*.test.ts` (serializer, cells, rasterizer, PNG encoder, planner, archive,
  and end-to-end compaction tests).
- `verify-package` — asserts the packed tarball ships the declared files (extension, library, bundled fonts), keeps
  `opentype.js` as the only runtime dependency, and defines no install scripts.
- `smoke-package` — packs, installs into a temp project with the pinned peers, loads the packed source via jiti, and
  checks the four event handlers and `/snapcompact` command register.

Keep pull requests focused, and update `README.md` and `CHANGELOG.md` when behavior changes.

## Releasing

Releases are cut from a GitHub Release; merging to `main` never publishes. Publishing uses npm trusted publishing
(OIDC) through the `release` environment — there is no `NPM_TOKEN`, and provenance is attached automatically. (The
one-time trusted-publisher and environment setup is a maintainer step done before the first release.)

To cut a release:

1. Bump the version in `package.json` and `package-lock.json` (`npm version <patch|minor|major> --no-git-tag-version`)
   and add a dated `CHANGELOG.md` entry, then merge to `main`.
2. Publish a GitHub Release tagged exactly `vX.Y.Z` (matching the package version). `publish.yml` re-runs the check
   gate, asserts the tag matches, and publishes with provenance. A prerelease validates without publishing, and the
   workflow's manual dispatch does a dry run.
3. Confirm the new version and provenance on npm.

## Credits

Repository conventions here — the CI gate, package-content verification, and clean-install smoke test — follow the
conventions established by [pi-copy-code](https://github.com/penumbral-labs/pi-copy-code) (MIT), extended for this
implementation.
