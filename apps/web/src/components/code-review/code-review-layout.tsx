import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { Schema } from "effect"
import { VcsRepositoryId } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"

import { UnderlineTabStrip, underlineTabClass } from "@/components/common/underline-link-tabs"
import {
	BranchForkIcon,
	ChartBarIcon,
	CircleWarningIcon,
	GearIcon,
	PlayRotateClockwiseIcon,
} from "@/components/icons"
import { DashboardPage } from "@/components/layout/dashboard-page"
import { pickTimeRangeSearch } from "@/components/time-range-picker/search"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { retainedInternalQuery } from "@/lib/services/common/internal-atom-client"
import {
	LONG_RANGE_PRESET_OPTIONS,
	PRESET_OPTIONS,
	relativeToAbsolute,
	type TimePreset,
} from "@/lib/time-utils"

import { AuthorLabel } from "./author-avatar"
import {
	CODE_REVIEW_CI_DEFAULT_PRESET,
	CODE_REVIEW_CI_MAX_RANGE_SECONDS,
	CODE_REVIEW_DEFAULT_PRESET,
	CODE_REVIEW_MAX_RANGE_SECONDS,
	type CodeReviewSearch,
} from "./code-review-search"

export type CodeReviewTab = "analytics" | "pull-requests" | "ci" | "issues" | "settings"

const TABS = [
	{ tab: "analytics", to: "/code-review", label: "Analytics", Icon: ChartBarIcon },
	{ tab: "pull-requests", to: "/code-review/pull-requests", label: "Pull requests", Icon: BranchForkIcon },
	{ tab: "ci", to: "/code-review/ci", label: "CI", Icon: PlayRotateClockwiseIcon },
	{ tab: "issues", to: "/code-review/issues", label: "Issues", Icon: CircleWarningIcon },
	{ tab: "settings", to: "/code-review/settings", label: "Settings", Icon: GearIcon },
] as const

/**
 * Real links rather than a `Tabs` widget: each tab is a route, so middle-click, Copy link and Back
 * work. The window and the repository and author filters travel between the tabs that read them.
 */
function CodeReviewTabs({
	active,
	search,
	className,
}: {
	active: CodeReviewTab
	search: CodeReviewSearch
	className?: string
}) {
	const carried = { ...pickTimeRangeSearch(search), repo: search.repo, author: search.author }
	// CI reads two weeks at most: a longer window from another tab falls back to CI's default.
	const toCi = fitsCi(search) ? carried : { repo: search.repo, author: search.author }
	return (
		<UnderlineTabStrip
			navigation
			label="Code review views"
			bleed={false}
			divided={false}
			className={cn("gap-0 overflow-visible", className)}
		>
			{TABS.map(({ tab, to, label, Icon }) => (
				<Link
					key={tab}
					to={to}
					search={tab === "settings" ? {} : tab === "ci" ? toCi : carried}
					aria-current={active === tab ? "page" : undefined}
					className={cn(
						underlineTabClass(active === tab),
						"h-9 gap-[7px] px-3 first:pl-0.5",
						active === tab ? "[&_svg]:text-primary" : "[&_svg]:text-muted-foreground",
					)}
				>
					<Icon size={14} aria-hidden />
					{label}
				</Link>
			))}
		</UnderlineTabStrip>
	)
}

/** The frame every Code Review tab renders in. */
export function CodeReviewLayout({
	active,
	search,
	toolbar,
	children,
}: {
	active: CodeReviewTab
	search: CodeReviewSearch
	/** The header's actions: the filters, on the tabs that have them. */
	toolbar?: ReactNode
	children: ReactNode
}) {
	const label = TABS.find((tab) => tab.tab === active)?.label

	return (
		<DashboardPage
			breadcrumbs={[{ label: "Code Review", href: "/code-review" }, ...(label ? [{ label }] : [])]}
			headerActions={toolbar}
			tabs={<CodeReviewTabs active={active} search={search} className="border-b border-border" />}
			gap="lg"
			scrollClassName="pb-8"
		>
			{children}
		</DashboardPage>
	)
}

const ALL = "all"

type FilterPatch = Partial<CodeReviewSearch> & { timePreset?: string }

/** The GitHub installation's repositories; `reviewedOnly` keeps those with reviews on. */
function useGithubRepositories(reviewedOnly: boolean) {
	const status = useAtomValue(
		retainedInternalQuery("integrations", "githubStatus", {
			reactivityKeys: ["githubIntegrationStatus"],
		}),
	)
	return Result.builder(status)
		.onSuccess((response) =>
			reviewedOnly
				? response.repositories.filter((repo) => repo.prReviewEnabled)
				: response.repositories,
		)
		.orElse(() => [])
}

function RepositorySelect({
	reviewedOnly,
	value,
	onChange,
}: {
	reviewedOnly: boolean
	value: VcsRepositoryId | undefined
	onChange: (repo: VcsRepositoryId | undefined) => void
}) {
	const repositories = useGithubRepositories(reviewedOnly)
	const items = Object.fromEntries([
		[ALL, "All repositories"],
		...repositories.map((repo) => [repo.id, repo.fullName]),
	])
	const isRepositoryId = Schema.is(VcsRepositoryId)
	return (
		<Select
			items={items}
			value={value ?? ALL}
			onValueChange={(next) => onChange(isRepositoryId(next) ? next : undefined)}
		>
			<SelectTrigger size="sm" className="w-full min-w-0 @2xl/page:w-48" aria-label="Repository">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ALL}>All repositories</SelectItem>
				{repositories.map((repo) => (
					<SelectItem key={repo.id} value={repo.id}>
						{repo.fullName}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}

function WindowControls({
	search,
	defaultPreset,
	presets,
	maxRangeSeconds,
	onChange,
}: {
	search: CodeReviewSearch
	defaultPreset: string
	presets: ReadonlyArray<TimePreset>
	maxRangeSeconds: number
	onChange: (patch: FilterPatch) => void
}) {
	return (
		<TimeRangeHeaderControls
			startTime={search.startTime}
			endTime={search.endTime}
			presetValue={search.timePreset ?? (search.startTime ? undefined : defaultPreset)}
			defaultPreset={defaultPreset}
			presets={presets}
			maxRangeSeconds={maxRangeSeconds}
			onTimeChange={(range) =>
				onChange(
					range.presetValue
						? { timePreset: range.presetValue, startTime: undefined, endTime: undefined }
						: { startTime: range.startTime, endTime: range.endTime, timePreset: undefined },
				)
			}
		/>
	)
}

/**
 * Repository, author and window. The repositories are the GitHub installation's; the authors are
 * whoever opened a reviewed pull request in the window and repository, read without the author
 * filter so picking one never empties the list. On Analytics, with no author picked, it is the
 * page's own query.
 */
export function CodeReviewFilters({
	search,
	window,
	onChange,
}: {
	search: CodeReviewSearch
	/** The resolved window, epoch ms. */
	window: { readonly startTime: number; readonly endTime: number }
	onChange: (patch: FilterPatch) => void
}) {
	const authorsResult = useAtomValue(
		retainedInternalQuery("codeReview", "analytics", {
			query: { ...window, repositoryId: search.repo, author: undefined },
		}),
	)
	const authors: ReadonlyArray<string> = Result.builder(authorsResult)
		.onSuccess((analytics) => analytics.authors.map((row) => row.author))
		.orElse(() => [])
	// A filter from a link keeps its option even when the author has nothing in the new window.
	const authorOptions =
		search.author && !authors.includes(search.author) ? [search.author, ...authors] : authors
	const authorItems = Object.fromEntries([[ALL, "All authors"], ...authorOptions.map((a) => [a, a])])

	return (
		<div className="flex flex-wrap items-center gap-2">
			<RepositorySelect reviewedOnly value={search.repo} onChange={(repo) => onChange({ repo })} />
			<Select
				items={authorItems}
				value={search.author ?? ALL}
				onValueChange={(value) =>
					onChange({ author: typeof value === "string" && value !== ALL ? value : undefined })
				}
			>
				<SelectTrigger size="sm" className="w-full min-w-0 @2xl/page:w-40" aria-label="Author">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={ALL}>All authors</SelectItem>
					{authorOptions.map((author) => (
						<SelectItem key={author} value={author}>
							<AuthorLabel login={author} />
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<WindowControls
				search={search}
				defaultPreset={CODE_REVIEW_DEFAULT_PRESET}
				presets={LONG_RANGE_PRESET_OPTIONS}
				maxRangeSeconds={CODE_REVIEW_MAX_RANGE_SECONDS}
				onChange={onChange}
			/>
		</div>
	)
}

/** CI keeps two weeks of raw traces: the presets stop there. */
const CI_PRESET_OPTIONS = PRESET_OPTIONS.filter((preset) => preset.value !== "1mo")

const fitsCi = (search: CodeReviewSearch) => {
	const range = search.timePreset !== undefined ? relativeToAbsolute(search.timePreset) : search
	if (range === null || range.startTime === undefined || range.endTime === undefined) return true
	return toEpochMs(range.endTime) - toEpochMs(range.startTime) <= CODE_REVIEW_CI_MAX_RANGE_SECONDS * 1000
}

/**
 * The CI tab's repository, workflow and window. Every repository of the installation runs CI,
 * reviewed or not. The workflows are those that ran in the window and repository, read without
 * the workflow filter (the page's own query until one is picked).
 */
export function CodeReviewCiFilters({
	search,
	pipeline,
	window,
	onChange,
}: {
	search: CodeReviewSearch
	pipeline: string | undefined
	/** The resolved window, epoch ms. */
	window: { readonly startTime: number; readonly endTime: number }
	onChange: (patch: FilterPatch & { pipeline?: string }) => void
}) {
	const pipelinesResult = useAtomValue(
		retainedInternalQuery("codeReview", "ciAnalytics", {
			query: { ...window, repositoryId: search.repo, pipeline: undefined },
		}),
	)
	const pipelines: ReadonlyArray<string> = Result.builder(pipelinesResult)
		.onSuccess((analytics) => [...new Set(analytics.pipelines.map((row) => row.pipeline))].sort())
		.orElse(() => [])
	// A workflow from a link keeps its option even when it did not run in the new window.
	const options = pipeline && !pipelines.includes(pipeline) ? [pipeline, ...pipelines] : pipelines
	const items = Object.fromEntries([[ALL, "All workflows"], ...options.map((name) => [name, name])])
	return (
		<div className="flex flex-wrap items-center gap-2">
			<RepositorySelect
				reviewedOnly={false}
				value={search.repo}
				onChange={(repo) => onChange({ repo })}
			/>
			<Select
				items={items}
				value={pipeline ?? ALL}
				onValueChange={(value) =>
					onChange({ pipeline: typeof value === "string" && value !== ALL ? value : undefined })
				}
			>
				<SelectTrigger size="sm" className="w-full min-w-0 @2xl/page:w-44" aria-label="Workflow">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={ALL}>All workflows</SelectItem>
					{options.map((name) => (
						<SelectItem key={name} value={name}>
							{name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<WindowControls
				search={search}
				defaultPreset={CODE_REVIEW_CI_DEFAULT_PRESET}
				presets={CI_PRESET_OPTIONS}
				maxRangeSeconds={CODE_REVIEW_CI_MAX_RANGE_SECONDS}
				onChange={onChange}
			/>
		</div>
	)
}

/** The empty state of a tab whose filters left nothing: one way back to everything. */
export function NothingInWindow({
	title,
	description,
	onClear,
}: {
	title: string
	description: string
	onClear?: () => void
}) {
	return (
		<Empty className="rounded-md border border-dashed md:py-14">
			<EmptyHeader>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
			{onClear ? (
				<Button variant="outline" size="sm" onClick={onClear}>
					Clear filters
				</Button>
			) : null}
		</Empty>
	)
}
