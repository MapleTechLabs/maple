import type * as React from "react"
import { cn } from "../../lib/utils"
import { Button, type ButtonProps } from "./button"
import { Spinner } from "./spinner"

/** "Load more" with a spinner while the next page is in flight. */
export function LoadMoreButton({
	loading = false,
	onClick,
	label = "Load more",
	variant = "outline",
	className,
}: {
	loading?: boolean
	onClick: () => void
	label?: React.ReactNode
	variant?: ButtonProps["variant"]
	className?: string
}): React.ReactElement {
	return (
		<Button variant={variant} size="sm" loading={loading} onClick={onClick} className={className}>
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
	singular,
	hasMore = false,
	loading = false,
	failed = false,
	capped = false,
	onLoadMore,
	align = "center",
	className,
	children,
}: {
	shown?: number
	total?: number
	/** Plural noun for the count copy ("logs", "traces"). */
	noun?: string
	/** Singular for a count of exactly one; defaults to `noun` minus a trailing "s". */
	singular?: string
	hasMore?: boolean
	loading?: boolean
	/** The last page failed; the button becomes a retry. */
	failed?: boolean
	capped?: boolean
	onLoadMore?: () => void
	align?: "start" | "center"
	className?: string
	/** Extra trailing content (a source note, a deep link). */
	children?: React.ReactNode
}): React.ReactElement | null {
	const one = singular ?? (noun && /[^s]s$/.test(noun) && !noun.endsWith("ies") ? noun.slice(0, -1) : noun)
	const nounFor = (n: number) => (n === 1 ? one : noun)
	const count =
		shown === undefined || !noun
			? null
			: total !== undefined && total > shown
				? `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} ${nounFor(total)}`
				: capped
					? `Showing first ${shown.toLocaleString()} ${nounFor(shown)}, narrow the filters to see more`
					: hasMore
						? `Showing ${shown.toLocaleString()} ${nounFor(shown)}, more available`
						: `${shown.toLocaleString()} ${nounFor(shown)}`

	const button =
		onLoadMore && (hasMore || failed) ? (
			<LoadMoreButton loading={loading} onClick={onLoadMore} label={failed ? "Retry" : "Load more"} />
		) : null

	if (!count && !button && !children) return null

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
			{children}
		</div>
	)
}

/** In-table "Loading more…" row for virtualized/infinite lists. */
export function LoadingMoreRow({
	label = "Loading more…",
	className,
}: {
	label?: string
	className?: string
}) {
	return (
		<div
			className={cn(
				"flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground",
				className,
			)}
			role="status"
		>
			<Spinner className="size-3.5" />
			{label}
		</div>
	)
}
