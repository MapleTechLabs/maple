export interface CacheInfo {
	system: string | null
	name: string | null
	operation: string | null
	lookupPerformed: boolean
	result: "hit" | "miss" | null
}

export function getCacheInfo(attrs: Record<string, string>): CacheInfo | null {
	const system = attrs["cache.system"]
	const result = attrs["cache.result"]

	if (!system && !result) return null

	return {
		system: system ?? null,
		name: attrs["cache.name"] ?? null,
		operation: attrs["cache.operation"] ?? null,
		lookupPerformed: attrs["cache.lookup_performed"] === "true",
		result: result === "hit" || result === "miss" ? result : null,
	}
}

export const cacheResultStyles = {
	hit: "bg-primary-a2 text-primary border-primary-a3",
	miss: "bg-chart-p50/15 text-chart-p50 border-chart-p50/30",
}
