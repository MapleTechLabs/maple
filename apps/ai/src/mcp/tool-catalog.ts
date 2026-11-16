import { Effect } from "effect"

/**
 * The tool catalog, loaded on the first call that needs it rather than with this module.
 *
 * It is the largest chunk in the Worker; `tools/call` never needs all of it (`tools/tool-lookup.ts`
 * loads one tool). The dynamic import also breaks the registry -> tool -> chat/maple-toolkit ->
 * dispatcher cycle, so no module can observe a half-built catalog.
 */
export const loadRegistry = Effect.promise(() => import("./tools/registry"))
