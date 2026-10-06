import { useCallback, useEffect } from "react"
import type { Virtualizer } from "@tanstack/react-virtual"

interface ReachEndSentinelProps {
	readonly onReachEnd?: () => void
	/** While a page is loading, entering the margin again does not ask for another. */
	readonly loading?: boolean
	readonly rootMargin?: string
}

/** A 1px marker at the end of an infinite list that asks for the next page as it nears view. */
export function ReachEndSentinel({ onReachEnd, loading = false, rootMargin = "400px 0px" }: ReachEndSentinelProps) {
	const elementRef = useCallback(
		(element: HTMLDivElement | null) => {
			if (!element) return
			const observer = new IntersectionObserver(
				(entries) => {
					if (entries[0]?.isIntersecting && !loading) onReachEnd?.()
				},
				{ rootMargin },
			)
			observer.observe(element)
			return () => observer.disconnect()
		},
		[loading, onReachEnd, rootMargin],
	)

	return <div ref={elementRef} aria-hidden className="h-px w-full" />
}

interface VirtualReachEndOptions {
	readonly count: number
	readonly hasMore: boolean
	readonly loading: boolean
	readonly onReachEnd: () => void
	/** Rows from the end at which the next page is requested. */
	readonly threshold?: number
}

/** The virtualized-list twin of {@link ReachEndSentinel}: fetch once the rendered window nears the end. */
export function useVirtualReachEnd<TScroll extends Element | Window, TItem extends Element>(
	virtualizer: Virtualizer<TScroll, TItem>,
	{ count, hasMore, loading, onReachEnd, threshold = 10 }: VirtualReachEndOptions,
): void {
	const lastIndex = virtualizer.getVirtualItems().at(-1)?.index ?? -1
	useEffect(() => {
		if (lastIndex < 0 || !hasMore || loading) return
		if (lastIndex >= count - threshold) onReachEnd()
	}, [lastIndex, count, hasMore, loading, onReachEnd, threshold])
}
