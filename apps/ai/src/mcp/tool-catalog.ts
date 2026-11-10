import { Effect } from "effect"

/**
 * The tool catalog, loaded on the first call that needs it rather than with this module.
 *
 * It is the largest chunk in the Worker, and most cold `/mcp` requests (`initialize`, the
 * resource and prompt lists, 401s) never touch a tool. The dynamic import also breaks the
 * registry -> tool -> chat/tools -> dispatcher cycle, so no module can observe a half-built catalog.
 */
export const loadRegistry = Effect.promise(() => import("./tools/registry"))
