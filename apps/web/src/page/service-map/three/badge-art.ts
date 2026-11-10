import type { Node3D } from "./types"
import { machineBadge } from "../badge"
import { MARK_PATHS } from "./mark-paths.generated"

/** The plate's artwork, resolved to an SVG path or a wordmark. */
export type MachineBadge = {
	readonly label: string
} & (
	| { readonly path: string; readonly wordmark?: never }
	| { readonly wordmark: string; readonly path?: never }
)

/** `machineBadge` with the mark key resolved to its path. */
export function resolveMachineBadge(node: Pick<Node3D, "kind" | "system" | "runtime">): MachineBadge | null {
	const badge = machineBadge(node)
	if (badge === null) return null
	if (badge.mark !== undefined) return { label: badge.label, path: MARK_PATHS[badge.mark] }
	return { label: badge.label, wordmark: badge.wordmark }
}
