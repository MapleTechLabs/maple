// The container fleet's scope counts, framework-free so the overview and the Foldkit port share them.

export interface ContainerScopeCounts {
	readonly totalContainers: number
	readonly saturatedContainers: number
	readonly elevatedContainers: number
	readonly staleContainers: number
}
