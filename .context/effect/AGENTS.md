This is the Effect library repository, focusing on functional programming patterns and effect systems in TypeScript.

## Overview

- The git base branch is `main`.
- Use `pnpm` as the package manager.
- Keep changes focused and follow established patterns in the repository.
- Before writing code, read the relevant files in `./.patterns/` and inspect similar existing code.

## Workflow

1. Inspect nearby implementation, tests, and pattern docs before editing.
2. Make the smallest focused change that solves the task.
3. Prefer existing abstractions and conventions over introducing new ones.
4. For ad hoc runnable code, create a temporary file in `scratchpad/`, run it with `node scratchpad/<file>.ts`, and delete it when done.
5. Run the validation appropriate to the change type.
6. Report which validation commands were run and any commands that could not be run.

## Validation

Use the narrowest validation that still covers the change:

| Change type                 | Validation                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Code changes                | `pnpm lint-fix`, targeted `pnpm test <test_file.ts>`, `pnpm check:tsgo`                                     |
| Tests-only changes          | `pnpm lint-fix`, targeted `pnpm test <test_file.ts>`, `pnpm check:tsgo`                                     |
| Type-level/API type changes | Targeted `pnpm test-types <filename>`, plus `pnpm check:tsgo` when source types changed                     |
| JSDoc/example changes       | From the changed package directory, run `pnpm docgen`; also run `pnpm check:tsgo` when source types changed |
| Docs-only changes           | `pnpm lint-fix`; no tests required unless examples or code changed                                          |

If `pnpm check:tsgo` continues to fail unexpectedly, run `pnpm clean` and then re-run `pnpm check:tsgo`.

## Coding Patterns

Read `.patterns/effect.md` before changing Effect code. In particular:

- Prefer `Effect.fnUntraced` over functions that only return `Effect.gen`.
- Prefer class syntax for `Context.Service`.
- Do not use `async` / `await` or `try` / `catch`; use Effect APIs such as `Effect.gen`, `Effect.fnUntraced`, and `Effect.tryPromise`.
- Do not use `Date.now` or `new Date`; use `Clock`, and use `TestClock` in tests.

## Testing

Read `.patterns/testing.md` before writing or changing tests.

- Test files are located in `packages/*/test/`.
- Main Effect library tests are in `packages/effect/test/`.
- Use `it.effect` for Effect-returning tests.
- Use regular `it` for pure synchronous tests.
- Do not use `Effect.runSync` in tests.
- Do not use `expect` from Vitest; use `assert` from `@effect/vitest`.
- Type-level tests are in `packages/*/typetest/` and run with `pnpm test-types <filename>`.

## Documentation

- For AI documentation, read `ai-docs/README.md` very carefully before writing examples.
- AI documentation changes may include explanatory comments when useful.
- For public JSDoc `@category` guidance, read `.patterns/jsdoc.md`.
- When JSDoc examples are localized to a single package, run `pnpm docgen` from that package directory instead of the repository root.

## Generated Files

Do not hand-edit generated files. Run the appropriate generator instead.

- `index.ts` barrel files are generated; run `pnpm codegen` after adding or removing modules.

## Changesets

Create a changeset in `.changeset/` for runtime behavior changes or exported type/API changes:

```md
---
"package-name": patch/minor/major
---

A description of the change.
```

Tests-only changes, internal refactors, docs-only changes, and JSDoc-only maintenance may skip changesets by maintainer decision.

## Asking Before Risky Changes

Ask before proceeding with broad refactors, public API changes, dependency or configuration changes, unclear requirements, or destructive operations.
