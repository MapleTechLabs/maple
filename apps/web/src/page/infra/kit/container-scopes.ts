// The container fleet's scope counts, framework-free.

export interface ContainerScopeCounts {
	readonly totalContainers: number
	readonly saturatedContainers: number
	readonly elevatedContainers: number
	readonly staleContainers: number
}
