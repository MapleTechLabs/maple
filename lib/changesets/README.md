# @maple/changesets

A drop-in for the parts of [`@changesets/cli`](https://github.com/changesets/changesets) 3.x that a
repository with a custom publish script uses: `changeset add`, `changeset version` and
`changeset status`. Its only dependencies are `effect` and `@effect/platform-node`.

It reads and writes the same files: `.changeset/*.md`, `.changeset/config.json`, `package.json`
versions and internal ranges, and `CHANGELOG.md` in the `@changesets/cli/changelog` format, which
the project's formatter then formats (`format: "auto"` detection included).

```bash
changeset                                  # interactive add (same as `changeset add`)
changeset --patch @scope/a,@scope/b --minor @scope/c -m "Summary"
changeset --empty
changeset version [--ignore <pkg>]
changeset status [--verbose] [--since <ref>] [--output <file>]
```

## Compatibility

`src/differential.test.ts` runs every fixture in `src/__fixtures__/` (including a snapshot of this
repository's own workspace) and compares the files written, the files deleted, the
`status --output` JSON and the exit codes with what `@changesets/cli` 3.0.3 produced.
`src/frontmatter.test.ts` does the same for changeset parsing. To re-record after changing a fixture:

```bash
bun add --cwd /tmp/changesets-ref @changesets/cli@3.0.3
CHANGESETS_CLI=/tmp/changesets-ref/node_modules/@changesets/cli/bin.js bun run record-reference
```

`changesets/action` keeps working: with `version-script` and `publish-script` set it never runs the
CLI. It reads `.changeset/` itself for `has-changesets` and reads the CHANGELOG entries for the PR body.

## Not implemented

These fail with a clear error instead of doing something different:

- `init`, `publish`, `publish-plan`, `pack`, `pre`, `git-tag`/`tag`, and `version --snapshot`.
- Pre mode (`.changeset/pre.json`) and `commit` other than `false`.
- Changelog modules other than `@changesets/cli/changelog` (or `@changesets/changelog-git`), `false`,
  or a path relative to `.changeset/`.

Known differences in what is accepted:

- Workspaces come from `package.json` `workspaces` next to a bun, yarn or npm lockfile;
  `pnpm-workspace.yaml`, Lerna and Rush roots are not detected.
- Ranges use `effect/SemVerRange`, which rejects some loose node-semver forms (`v1.2.3`, `~>1.2`,
  build metadata in a range). Such a range is left untouched, as changesets does for invalid ranges.
- Frontmatter is a YAML subset: block or flow mappings of plain or quoted scalars. Anchors, tags and
  block scalars are reported as invalid YAML.
- `$VISUAL`/`$EDITOR` is split on whitespace and run without a shell.
