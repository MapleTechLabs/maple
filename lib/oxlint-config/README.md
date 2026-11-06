# @maple-dev/oxlint-config

The strict oxlint setup Maple runs in CI, packaged so another Effect + TypeScript project can
take it as-is. Four presets, three JS plugins, no Maple knowledge.

| Preset        | What it enforces                                                                                                                                                          | Needs                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `base.json`   | Built-in correctness picks, `no-explicit-any`, no non-null assertions, the vendored [anti-slop](plugins/anti-slop/UPSTREAM.md) rules, stale disable directives are errors | `oxlint`, `@oxlint/plugins`                   |
| `effect.json` | Every `@effect/tsgo` strict + effect-native rule at error, 31 type-aware TypeScript bug rules, `no-unsafe-*`, `effect-strict/*`                                           | `oxlint-tsgolint`, `@effect/tsgo`, a tsconfig |
| `tests.json`  | `test-slop/*` (tests that cannot catch a bug) + Vitest basics, on `*.test.*` / `*.spec.*`                                                                                 | nothing extra                                 |
| `react.json`  | No direct `useEffect`; one sanctioned mount hook                                                                                                                          | React project                                 |

Every rule is `error`. CI runs `oxlint --quiet`, and a `warn` rule enforces nothing.

## Install

```bash
bun add -d @maple-dev/oxlint-config oxlint @oxlint/plugins oxlint-tsgolint @effect/tsgo
```

`effecttsgo/*` rules come from `@effect/tsgo` patching `oxlint-tsgolint`. Add it to `prepare` so a
fresh install is patched:

```json
"prepare": "effect-tsgo patch --no-typescript --oxlint"
```

## Use

`extends` takes relative file paths only (bare package specifiers do not resolve):

```jsonc
// .oxlintrc.json
{
	"extends": [
		"./node_modules/@maple-dev/oxlint-config/base.json",
		"./node_modules/@maple-dev/oxlint-config/effect.json",
		"./node_modules/@maple-dev/oxlint-config/tests.json",
		"./node_modules/@maple-dev/oxlint-config/react.json",
	],
	"rules": {
		// Project decisions go here, each with its reason.
	},
}
```

```bash
oxlint -c .oxlintrc.json --quiet src
```

Plugin paths and overrides inside the presets resolve relative to the preset, so they work from
`node_modules`. Without a copy step you can also vendor the folder; nothing in it imports Maple.

## Rules we differ from upstream on

Upstream `@effect/tsgo` presets ship most rules at `warn`; `effect.json` raises all of them to
`error` and then turns off the ones that cost more than they catch. The reason for each sits next
to the rule in `effect.json`:

- `unstable-api-usage` off: `effect/unstable/*` is the normal Effect 4 surface.
- `schema-number` off: a blanket `Schema.Finite` turns a computed NaN into a decode failure.
- `schema-class-missing-brand`, `global-date`, `async-function`, `node-builtin-import`,
  `schema-sync` off: noise at the boundaries they fire on; the `*-in-effect` variants stay on.
- `strict-boolean-expressions` with numbers disallowed: `if (count)` hides 0 and NaN.

Overrides relax host globals, sync decodes and `no-unsafe-*` in tests, scripts, benches, build
configs and plain `.js`.

## `effect-strict` plugin

| Rule                   | Why                                                                     |
| ---------------------- | ----------------------------------------------------------------------- |
| `no-try-catch`         | Failures go through the typed error channel (`Effect.try`, `catchTag`). |
| `no-effect-die`        | And not through defects; a real defect gets a disable line with reason. |
| `no-date-parse`        | A zone-less timestamp is read in the host timezone.                     |
| `no-record-string-any` | The worst `any`; generic constraints are allowed.                       |
| `no-react-use-effect`  | Option `allowFiles` names your mount hook.                              |

## Maintaining

- After bumping `@effect/tsgo`: `bun run sync:effect` regenerates `effect.json` from the installed
  presets plus the decisions in `scripts/sync-effect-preset.mjs`. Edit the script, not the JSON.
- `plugins/anti-slop.mjs` is bundled from `plugins/anti-slop/` by `bun run build` (and on
  `prepack`): Node will not strip types from a `.ts` file under `node_modules`. Rebuild after
  editing a rule.
- `bun run smoke` packs the package, installs the tarball into a throwaway project, and a throwaway project with one planted violation per rule family and
  fails if any preset stops reporting it, or if the clean file picks up a hit.
