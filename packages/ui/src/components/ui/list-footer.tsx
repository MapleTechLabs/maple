import type * as React from "react"
import { cn } from "../../lib/utils"
import { Button } from "./button"
import { Spinner } from "./spinner"

/** "Load more" with a spinner while the next page is in flight. */
export function LoadMoreButton({
	loading = false,
	onClick,
	label = "Load more",
	className,
}: {
	loading?: boolean
	onClick: () => void
	label?: React.ReactNode
	className?: string
}): React.ReactElement {
	return (
		<Button variant="outline" size="sm" loading={loading} onClick={onClick} className={className}>
			{label}
		</Button>
	)
}

/**
 * The footer under a paged list: how much is shown, and the button for more.
 * `capped` is for lists that stop at a server limit with no further pages.
 */
export function ListFooter({
	shown,
	total,
	noun,
	hasMore = false,
	loading = false,
	failed = false,
	capped = false,
	onLoadMore,
	align = "center",
	className,
}: {
	shown?: number
	total?: number
	/** Plural noun for the count copy ("logs", "traces"). */
	noun?: string
	hasMore?: boolean
	loading?: boolean
	/** The last page failed; the button becomes a retry. */
	failed?: boolean
	capped?: boolean
	onLoadMore?: () => void
	align?: "start" | "center"
	className?: string
}): React.ReactElement | null {
	const count =
		shown === undefined || !noun
			? null
			: total !== undefined && total > shown
				? `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} ${noun}`
				: capped
					? `Showing first ${shown.toLocaleString()} ${noun}, narrow the filters to see more`
					: hasMore
						? `Showing ${shown.toLocaleString()} ${noun}, more available`
						: `${shown.toLocaleString()} ${noun}`

	const button =
		onLoadMore && (hasMore || failed) ? (
			<LoadMoreButton loading={loading} onClick={onLoadMore} label={failed ? "Retry" : "Load more"} />
		) : null

	if (!count && !button) return null

	return (
		<div
			className={cn(
				"flex flex-wrap items-center gap-3 px-4 py-3 text-xs text-muted-foreground tabular-nums",
				align === "center" ? "justify-center" : "justify-between",
				className,
			)}
			data-slot="list-footer"
		>
			{count ? <span>{count}</span> : null}
			{button}
		</div>
	)
}

/** In-table "Loading more…" row for virtualized/infinite lists. */
export function LoadingMoreRow({ label = "Loading more…", className }: { label?: string; className?: string }) {
	return (
		<div
			className={cn("flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground", className)}
			role="status"
		>
			<Spinner className="size-3.5" />
			{label}
		</div>
	)
}
