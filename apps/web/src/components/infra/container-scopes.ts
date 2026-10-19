// The container fleet's scope counts, framework-free so the overview and the Foldkit port share them.

export interface ContainerScopeCounts {
	readonly totalContainers: number
	readonly saturatedContainers: number
	readonly elevatedContainers: number
	readonly staleContainers: number
}

/** A one-click scope. `undefined` means "no scope" (the All cell). */
export type ContainerScope = "saturated" | "elevated" | "stale"
