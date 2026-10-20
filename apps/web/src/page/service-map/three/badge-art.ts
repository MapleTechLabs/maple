import type { Node3D } from "../../../components/service-map/three/types"
import { machineBadge } from "../badge"
import { MARK_PATHS } from "./mark-paths.generated"

/** factory-badge.ts's `MachineBadge`: the plate's artwork, resolved to an SVG path or a wordmark. */
export type MachineBadge = {
	readonly label: string
} & (
	| { readonly path: string; readonly wordmark?: never }
	| { readonly wordmark: string; readonly path?: never }
)

/** `resolveMachineBadge` with the mark key resolved to its path. */
export function resolveMachineBadge(node: Pick<Node3D, "kind" | "system" | "runtime">): MachineBadge | null {
	const badge = machineBadge(node)
	if (badge === null) return null
	if (badge.mark !== undefined) return { label: badge.label, path: MARK_PATHS[badge.mark] }
	return { label: badge.label, wordmark: badge.wordmark }
}
