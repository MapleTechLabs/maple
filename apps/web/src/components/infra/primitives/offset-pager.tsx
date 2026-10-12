import { useState } from "react"
import { Button } from "@maple/ui/components/ui/button"
import { ListFooter } from "@maple/ui/components/ui/list-footer"

/**
 * Page index for an offset-paged list that snaps back to the first page whenever
 * `resetKey` (filters, search, sort) changes, without an effect.
 */
export function useResettingPage(resetKey: string) {
	const [state, setState] = useState({ key: resetKey, page: 0 })
	const page = state.key === resetKey ? state.page : 0
	const setPage = (next: number) => setState({ key: resetKey, page: Math.max(0, next) })
	return [page, setPage] as const
}

/** "51-100 of 1,234 pods" for the toolbar of a page past the first. */
export function pageRangeLabel(offset: number, shown: number, total: number, noun: string): string {
	if (shown === 0) return `0 of ${total.toLocaleString()} ${noun}`
	return `${(offset + 1).toLocaleString()}-${(offset + shown).toLocaleString()} of ${total.toLocaleString()} ${noun}`
}

/** Previous / next footer under a server-paged table. Renders nothing for a single page. */
export function OffsetPager({
	offset,
	shown,
	total,
	pageSize,
	noun,
	onPageChange,
}: {
	offset: number
	shown: number
	total: number
	pageSize: number
	/** Plural noun ("pods"). */
	noun: string
	onPageChange: (direction: 1 | -1) => void
}) {
	const hasPrevious = offset > 0
	const hasNext = offset + shown < total
	if (!hasPrevious && !hasNext) return null
	const page = Math.floor(offset / pageSize) + 1
	const pages = Math.max(1, Math.ceil(total / pageSize))
	return (
		<ListFooter align="start" className="px-0 py-1">
			<span>{pageRangeLabel(offset, shown, total, noun)}</span>
			<div className="ml-auto flex items-center gap-2">
				<span>
					Page {page.toLocaleString()} of {pages.toLocaleString()}
				</span>
				<Button variant="outline" size="sm" disabled={!hasPrevious} onClick={() => onPageChange(-1)}>
					Previous
				</Button>
				<Button variant="outline" size="sm" disabled={!hasNext} onClick={() => onPageChange(1)}>
					Next
				</Button>
			</div>
		</ListFooter>
	)
}
