import { useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import {
	PrReviewCategory,
	PrReviewFindingStatus,
	PrReviewSeverity,
	type CodeReviewFinding,
} from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { ListFooter } from "@maple/ui/components/ui/list-footer"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { SkeletonList } from "@maple/ui/components/ui/skeleton"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { ListRow } from "@maple/ui/components/ui/list-row"
import { Panel } from "@maple/ui/components/ui/panel"
import { RelativeTime } from "@/components/common/relative-time"

import {
	CATEGORY_LABELS,
	FINDING_STATUS_LABELS,
	SEVERITY_LABELS,
	SEVERITY_TONE,
} from "@/components/code-review/code-review-format"
import {
	CodeReviewFilters,
	CodeReviewLayout,
	NothingInWindow,
} from "@/components/code-review/code-review-layout"
import {
	CODE_REVIEW_DEFAULT_PRESET,
	CodeReviewIssuesSearchFields,
	type CodeReviewSearch,
} from "@/components/code-review/code-review-search"
import { ReviewDetailSheet } from "@/components/code-review/review-detail-sheet"
import { ResultView } from "@/components/common/result-view"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { retainedQuery } from "@/lib/services/common/atom-client"

const searchSchema = Schema.Struct(CodeReviewIssuesSearchFields)
type IssuesSearch = Schema.Schema.Type<typeof searchSchema>

export const Route = createFileRoute("/code-review/issues")({
	component: CodeReviewIssuesPage,
	validateSearch: Schema.toStandardSchemaV1(searchSchema),
})

const PAGE = 50
const MAX_ROWS = 200
const ALL = "all"

function CodeReviewIssuesPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const preset = search.timePreset ?? CODE_REVIEW_DEFAULT_PRESET
	const { startTime, endTime } = useEffectiveTimeRange(search.startTime, search.endTime, preset)
	// The resolved window, shared by the page's query and the filters' author list.
	const window = { startTime: toEpochMs(startTime), endTime: toEpochMs(endTime) }
	const [limit, setLimit] = useState(PAGE)

	const query = retainedQuery("codeReview", "listFindings", {
		query: {
			...window,
			repositoryId: search.repo,
			author: search.author,
			severity: search.severity,
			category: search.category,
			status: search.state,
			limit,
		},
	})
	const result = useAtomValue(query)
	const refresh = useAtomRefresh(query)

	const onChange = (
		patch: Partial<CodeReviewSearch> & Partial<Omit<IssuesSearch, keyof CodeReviewSearch>>,
	) => {
		// Opening or closing a review keeps the rows already loaded; a filter change starts over.
		if (Object.keys(patch).some((key) => key !== "review")) setLimit(PAGE)
		void navigate({ search: (prev) => ({ ...prev, ...patch }) })
	}
	const filtered =
		search.repo !== undefined ||
		search.author !== undefined ||
		search.severity !== undefined ||
		search.category !== undefined ||
		search.state !== undefined

	return (
		<CodeReviewLayout
			active="issues"
			search={search}
			toolbar={<CodeReviewFilters search={search} window={window} onChange={onChange} />}
		>
			<div className="flex flex-wrap items-center gap-2">
				<FilterSelect
					label="Severity"
					value={search.severity}
					options={PrReviewSeverity.literals.map(
						(value) => [value, SEVERITY_LABELS[value]] as const,
					)}
					allLabel="All severities"
					onChange={(severity) => onChange({ severity })}
				/>
				<FilterSelect
					label="Category"
					value={search.category}
					options={PrReviewCategory.literals.map(
						(value) => [value, CATEGORY_LABELS[value]] as const,
					)}
					allLabel="All categories"
					onChange={(category) => onChange({ category })}
				/>
				<FilterSelect
					label="State"
					value={search.state}
					options={PrReviewFindingStatus.literals.map(
						(value) => [value, FINDING_STATUS_LABELS[value]] as const,
					)}
					allLabel="Any state"
					onChange={(state) => onChange({ state })}
				/>
			</div>
			<ResultView
				result={result}
				loading={<SkeletonList rows={6} rowClassName="h-16" gap="2" />}
				errorTitle="Failed to load issues"
				onRetry={refresh}
				isEmpty={(response) => response.findings.length === 0}
				empty={
					<NothingInWindow
						title="No issues in this window"
						description={
							filtered
								? "Nothing matches these filters."
								: "Issues the reviewer posts on pull requests are listed here."
						}
						onClear={
							filtered
								? () =>
										onChange({
											repo: undefined,
											author: undefined,
											severity: undefined,
											category: undefined,
											state: undefined,
										})
								: undefined
						}
					/>
				}
			>
				{(response) => (
					<div className="flex flex-col gap-3">
						<Panel>
							<ul className="divide-y">
								{response.findings.map((finding) => (
									<FindingRow
										key={finding.id}
										finding={finding}
										onOpen={() => onChange({ review: finding.reviewId })}
									/>
								))}
							</ul>
						</Panel>
						{response.nextCursor !== null ? (
							<ListFooter
								shown={response.findings.length}
								noun="issues"
								hasMore={limit < MAX_ROWS}
								capped={limit >= MAX_ROWS}
								loading={result.waiting}
								onLoadMore={() => setLimit((current) => Math.min(current + PAGE, MAX_ROWS))}
							/>
						) : null}
					</div>
				)}
			</ResultView>
			<ReviewDetailSheet
				reviewId={search.review}
				onClose={() => onChange({ review: undefined })}
				onSelect={(review) => onChange({ review })}
			/>
		</CodeReviewLayout>
	)
}

/** One of a literal's values, or all of them; only a listed option ever reaches `onChange`. */
function FilterSelect<T extends string>({
	label,
	value,
	options,
	allLabel,
	onChange,
}: {
	label: string
	value: T | undefined
	options: ReadonlyArray<readonly [T, string]>
	allLabel: string
	onChange: (value: T | undefined) => void
}) {
	const items = Object.fromEntries([[ALL, allLabel], ...options])
	return (
		<Select
			items={items}
			value={value ?? ALL}
			onValueChange={(next) => onChange(options.find(([key]) => key === next)?.[0])}
		>
			<SelectTrigger size="sm" className="w-40" aria-label={label}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ALL}>{allLabel}</SelectItem>
				{options.map(([key, text]) => (
					<SelectItem key={key} value={key}>
						{text}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}

function FindingRow({ finding, onOpen }: { finding: CodeReviewFinding; onOpen: () => void }) {
	return (
		<li>
			<ListRow
				render={<button type="button" onClick={onOpen} />}
				leading={
					<span
						className={cn("w-16 text-xs font-medium", TONE_TEXT[SEVERITY_TONE[finding.severity]])}
					>
						{SEVERITY_LABELS[finding.severity]}
					</span>
				}
				title={finding.title}
				meta={
					<span className="flex min-w-0 items-center gap-1.5">
						<span className="truncate font-mono">
							{finding.path}:{finding.line}
						</span>
						<span className="shrink-0">
							· {finding.repositoryFullName}#{finding.number}
						</span>
					</span>
				}
				trailing={
					<>
						<span className="hidden text-xs text-muted-foreground sm:block">
							{CATEGORY_LABELS[finding.category]}
						</span>
						<Badge variant="outline" size="sm">
							{FINDING_STATUS_LABELS[finding.status]}
						</Badge>
						<RelativeTime
							value={finding.createdAt}
							className="hidden w-20 text-right text-xs text-muted-foreground md:block"
						/>
					</>
				}
			/>
		</li>
	)
}
