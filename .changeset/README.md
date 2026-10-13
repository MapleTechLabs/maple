# Changesets

Releases of the public npm packages (`@maple-dev/effect-sdk`, `@maple-dev/browser`,
`@maple-dev/alchemy`) are driven by changesets. Run `bunx changeset` in a PR that changes one
of them, pick the bump, and describe the change for the CHANGELOG.

On `main`, `.github/workflows/release.yml` keeps a "Version Packages" PR open. Merging it
publishes every bumped package to npm (`scripts/publish-packages.ts`) and tags the release.

## The `maple` CLI

`@maple/cli` is private, so it is versioned here but never published to npm. Add a changeset
for any user-visible CLI change (`bunx changeset`, pick `@maple/cli`). Merging the Version
Packages PR bumps `apps/cli/package.json` and writes `apps/cli/CHANGELOG.md`; the CLI embeds
that file for `maple changelog`.

The release itself is still the `v*` tag: after the Version Packages PR merges, push
`v<version>` (matching `apps/cli/package.json`). `.github/workflows/local-binary-release.yml`
builds the bundles and puts that version's changelog section at the top of the GitHub release.
