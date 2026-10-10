# Changesets

Releases of the public npm packages (`@maple-dev/effect-sdk`, `@maple-dev/browser`,
`@maple-dev/alchemy`) are driven by changesets. Run `bunx changeset` in a PR that changes one
of them, pick the bump, and describe the change for the CHANGELOG.

On `main`, `.github/workflows/release.yml` keeps a "Version Packages" PR open. Merging it
publishes every bumped package to npm (`scripts/publish-packages.ts`) and tags the release.
