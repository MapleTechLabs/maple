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

	// Detect cache span if any cache.* attribute is present
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

export const CACHE_OPERATION_COLORS: Record<string, string> = {
	GET: "bg-cache-get",
	SET: "bg-cache-set",
	DELETE: "bg-cache-delete",
} satisfies Record<string, string>
