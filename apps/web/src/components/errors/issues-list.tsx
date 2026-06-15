import { type ReactNode, useCallback, useMemo, useRef, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import type { ErrorIssueDocument, ErrorIssueId, WorkflowState } from "@maple/domain/http"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"

import { useListNavigation } from "@/hooks/use-list-navigation"
import { IssueGroup } from "./issue-group"
import { IssuesBulkBar } from "./issues-bulk-bar"
import { severityRank } from "./severity-badge"
import type { SelectToggleEvent } from "./issue-row"
import type { IssueMutations } from "./use-issue-mutations"

const GROUP_ORDER: ReadonlyArray<WorkflowState> = [
	"triage",
	"todo",
	"in_progress",
	"in_review",
	"done",
	"cancelled",
	"wontfix",
]

function scrollIntoView(issueId: string) {
	if (typeof document === "undefined") return
	const el = document.querySelector<HTMLElement>(`[data-issue-id="${CSS.escape(issueId)}"]`)
	if (!el) return
	el.scrollIntoView({ block: "nearest", behavior: "smooth" })
}

export interface IssuesListProps {
	/** Already-filtered issues to display, grouped here by workflow state. */
	issues: ReadonlyArray<ErrorIssueDocument>
	mutations: IssueMutations
	/** Dim the list while a background refresh is in flight. */
	isRefreshing?: boolean
	/** Rendered when there are no issues to show (e.g. a filter-aware message). */
	emptyState?: ReactNode
}

/**
 * Grouped, keyboard-navigable issue list shared by the Errors page. Owns
 * selection state, range-select anchoring, vim-style navigation, and the
 * floating bulk-action bar. Filtering happens upstream — this only groups,
 * sorts (severity → priority → last seen), and renders.
 */
export function IssuesList({ issues, mutations, isRefreshing = false, emptyState }: IssuesListProps) {
	const navigate = useNavigate()
	const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
	const anchorRef = useRef<string | null>(null)

	const grouped = useMemo(() => {
		const map = new Map<WorkflowState, ErrorIssueDocument[]>()
		for (const issue of issues) {
			const bucket = map.get(issue.workflowState) ?? []
			bucket.push(issue)
			map.set(issue.workflowState, bucket)
		}
		for (const bucket of map.values()) {
			bucket.sort((a, b) => {
				const severityDiff = severityRank(a.severity) - severityRank(b.severity)
				if (severityDiff !== 0) return severityDiff
				if (a.priority !== b.priority) return a.priority - b.priority
				return b.lastSeenAt.localeCompare(a.lastSeenAt)
			})
		}
		return map
	}, [issues])

	const visibleGroups = useMemo(
		() => GROUP_ORDER.filter((state) => (grouped.get(state)?.length ?? 0) > 0),
		[grouped],
	)

	const flatIssues = useMemo<ReadonlyArray<ErrorIssueDocument>>(() => {
		const out: ErrorIssueDocument[] = []
		for (const state of visibleGroups) {
			const bucket = grouped.get(state)
			if (bucket) out.push(...bucket)
		}
		return out
	}, [grouped, visibleGroups])

	const flatIssueIds = useMemo(() => flatIssues.map((i) => i.id as string), [flatIssues])

	const selectedArray = useMemo(
		() => flatIssues.filter((i) => selectedIds.has(i.id)).map((i) => i.id as ErrorIssueId),
		[flatIssues, selectedIds],
	)

	const toggleSelection = useCallback(
		(id: string, event: Pick<SelectToggleEvent, "shiftKey">) => {
			setSelectedIds((prev) => {
				const next = new Set(prev)
				if (event.shiftKey && anchorRef.current) {
					const a = flatIssueIds.indexOf(anchorRef.current)
					const b = flatIssueIds.indexOf(id)
					if (a !== -1 && b !== -1) {
						const [lo, hi] = a < b ? [a, b] : [b, a]
						for (let i = lo; i <= hi; i++) next.add(flatIssueIds[i]!)
						return next
					}
				}
				if (next.has(id)) next.delete(id)
				else next.add(id)
				anchorRef.current = id
				return next
			})
		},
		[flatIssueIds],
	)

	const clearSelection = useCallback(() => {
		setSelectedIds(new Set())
	}, [])

	const { focusedId, setFocusedId } = useListNavigation({
		ids: flatIssueIds,
		onOpen: (id) => {
			navigate({
				to: "/errors/issues/$issueId",
				params: { issueId: id as ErrorIssueId },
			})
		},
		onToggleSelect: toggleSelection,
		onEscape: () => {
			if (selectedIds.size === 0) return false
			clearSelection()
			return true
		},
		scrollTo: (id) => scrollIntoView(id),
	})

	const handleSelectToggle = useCallback(
		(id: string, event: SelectToggleEvent) => {
			toggleSelection(id, event)
			setFocusedId(id)
		},
		[toggleSelection, setFocusedId],
	)

	const handleFocus = useCallback(
		(id: string) => {
			setFocusedId(id)
		},
		[setFocusedId],
	)

	return (
		<div
			className={isRefreshing ? "opacity-60 transition-opacity" : undefined}
			aria-busy={isRefreshing}
		>
			{issues.length === 0 ? (
				<div className="p-4">
					{emptyState ?? (
						<Empty>
							<EmptyHeader>
								<EmptyTitle>No issues</EmptyTitle>
								<EmptyDescription>Nothing matches the current filters.</EmptyDescription>
							</EmptyHeader>
						</Empty>
					)}
				</div>
			) : (
				<div>
					{visibleGroups.map((state) => (
						<IssueGroup
							key={state}
							state={state}
							issues={grouped.get(state) ?? []}
							mutations={mutations}
							selectedIds={selectedIds}
							focusedId={focusedId}
							onSelectToggle={handleSelectToggle}
							onFocus={handleFocus}
						/>
					))}
				</div>
			)}
			<IssuesBulkBar selectedIds={selectedArray} mutations={mutations} onClear={clearSelection} />
		</div>
	)
}
