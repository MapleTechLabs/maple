import { useCallback } from "react"
import { Option } from "effect"
import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { useQueryParams } from "../lib/router"
import { DEFAULT_RANGE, isRangeKey } from "../lib/time"

const STORAGE_KEY = "maple-local:range"

// Read once per page load; `setRange` keeps it current after that.
let remembered: string | undefined

function rememberedRange(): string {
	remembered ??= Option.getOrElse(
		Option.filter(readLocalStorage(STORAGE_KEY), isRangeKey),
		() => DEFAULT_RANGE,
	)
	return remembered
}

/** The effective range for a hash query: its own `range`, else the viewer's last pick. */
export function rangeFromQuery(query: URLSearchParams): string {
	const fromUrl = query.get("range")
	return isRangeKey(fromUrl) ? fromUrl : rememberedRange()
}

/**
 * The app-wide time range. The hash carries it (shareable, survives nav), and
 * the last choice is remembered per browser for pages opened without one.
 */
export function useRange(): readonly [string, (next: string) => void] {
	const [query, setParams] = useQueryParams()
	const range = rangeFromQuery(query)
	const setRange = useCallback(
		(next: string) => {
			remembered = next
			writeLocalStorage(STORAGE_KEY, next)
			setParams({ range: next })
		},
		[setParams],
	)
	return [range, setRange] as const
}
