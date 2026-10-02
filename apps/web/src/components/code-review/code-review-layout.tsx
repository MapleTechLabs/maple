import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { Schema } from "effect"
import { VcsRepositoryId } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import { BranchForkIcon, ChartBarIcon, CircleWarningIcon, GearIcon } from "@/components/icons"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { pickTimeRangeSearch } from "@/components/time-range-picker/search"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { useOrganizationFeatureFlags } from "@/hooks/use-organization-feature-flags"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { retainedQuery } from "@/lib/services/common/atom-client"
import { LONG_RANGE_PRESET_OPTIONS } from "@/lib/time-utils"

import { AuthorLabel } from "./author-avatar"
import {
	CODE_REVIEW_DEFAULT_PRESET,
	CODE_REVIEW_MAX_RANGE_SECONDS,
	type CodeReviewSearch,
} from "./code-review-search"

export type CodeReviewTab = "analytics" | "pull-requests" | "issues" | "settings"

const TABS = [
	{ tab: "analytics", to: "/code-review", label: "Analytics", Icon: ChartBarIcon },
	{ tab: "pull-requests", to: "/code-review/pull-requests", label: "Pull requests", Icon: BranchForkIcon },
	{ tab: "issues", to: "/code-review/issues", label: "Issues", Icon: CircleWarningIcon },
	{ tab: "settings", to: "/code-review/settings", label: "Settings", Icon: GearIcon },
] as const

/**
 * Real links rather than a `Tabs` widget: each tab is a route, so middle-click, Copy link and Back
 * work. The window and the repository and author filters travel between the tabs that read them.
 */
function CodeReviewTabs({ active, search }: { active: CodeReviewTab; search: CodeReviewSearch }) {
	const carried = { ...pickTimeRangeSearch(search), repo: search.repo, author: search.author }
	return (
		<nav className="flex items-center self-end" aria-label="Code review views">
			{TABS.map(({ tab, to, label, Icon }) => (
				<Link
					key={tab}
					to={to}
					search={tab === "settings" ? {} : carried}
					aria-current={active === tab ? "page" : undefined}
					className={cn(
						"-mb-px flex h-9 items-center gap-[7px] border-b-2 px-3 text-sm transition-colors first:pl-0.5",
						active === tab
							? "border-primary font-medium text-foreground [&_svg]:text-primary"
							: "border-transparent text-muted-foreground hover:text-foreground [&_svg]:text-muted-foreground",
					)}
				>
					<Icon size={14} aria-hidden />
					{label}
				</Link>
			))}
		</nav>
	)
}

/**
 * The frame every Code Review tab renders in. Gated on the `prReview` rollout like the reviewer
 * itself; while the flags load, a skeleton rather than a not-enabled flash.
 */
export function CodeReviewLayout({
	active,
	search,
	toolbar,
	children,
}: {
	active: CodeReviewTab
	search: CodeReviewSearch
	/** Right of the title: the filters, on the tabs that have them. */
	toolbar?: ReactNode
	children: ReactNode
}) {
	const { flags, isLoaded } = useOrganizationFeatureFlags()
	const label = TABS.find((tab) => tab.tab === active)?.label

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? CODE_REVIEW_DEFAULT_PRESET}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs
					items={[{ label: "Code Review", href: "/code-review" }, ...(label ? [{ label }] : [])]}
				/>
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Scroll>
							{!isLoaded ? (
								<div className="space-y-4">
									<Skeleton className="h-9 w-full" />
									<Skeleton className="h-28 w-full" />
									<Skeleton className="h-72 w-full" />
								</div>
							) : !flags.prReview ? (
								<Empty>
									<EmptyHeader>
										<EmptyTitle>Code review is not enabled</EmptyTitle>
										<EmptyDescription>
											Pull request reviews are rolling out by organization. Ask us to
											turn them on for yours.
										</EmptyDescription>
									</EmptyHeader>
								</Empty>
							) : (
								<div className="flex flex-col gap-6 pb-8">
									<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border">
										<CodeReviewTabs active={active} search={search} />
										{toolbar ? <div className="pb-2">{toolbar}</div> : null}
									</div>
									{children}
								</div>
							)}
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}

const ALL = "all"

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
	onChange: (patch: Partial<CodeReviewSearch> & { timePreset?: string }) => void
}) {
	const authorsResult = useAtomValue(
		retainedQuery("codeReview", "analytics", {
			query: { ...window, repositoryId: search.repo, author: undefined },
		}),
	)
	const authors: ReadonlyArray<string> = Result.builder(authorsResult)
		.onSuccess((analytics) => analytics.authors.map((row) => row.author))
		.orElse(() => [])
	const status = useAtomValue(
		retainedQuery("integrations", "githubStatus", { reactivityKeys: ["githubIntegrationStatus"] }),
	)
	const repositories = Result.builder(status)
		.onSuccess((response) => response.repositories.filter((repo) => repo.prReviewEnabled))
		.orElse(() => [])
	const repoItems = Object.fromEntries([
		[ALL, "All repositories"],
		...repositories.map((repo) => [repo.id, repo.fullName]),
	])
	// A filter from a link keeps its option even when the author has nothing in the new window.
	const authorOptions =
		search.author && !authors.includes(search.author) ? [search.author, ...authors] : authors
	const authorItems = Object.fromEntries([[ALL, "All authors"], ...authorOptions.map((a) => [a, a])])
	const isRepositoryId = Schema.is(VcsRepositoryId)

	return (
		<div className="flex flex-wrap items-center gap-2">
			<Select
				items={repoItems}
				value={search.repo ?? ALL}
				onValueChange={(value) => onChange({ repo: isRepositoryId(value) ? value : undefined })}
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
			<TimeRangeHeaderControls
				startTime={search.startTime}
				endTime={search.endTime}
				presetValue={search.timePreset ?? (search.startTime ? undefined : CODE_REVIEW_DEFAULT_PRESET)}
				defaultPreset={CODE_REVIEW_DEFAULT_PRESET}
				presets={LONG_RANGE_PRESET_OPTIONS}
				maxRangeSeconds={CODE_REVIEW_MAX_RANGE_SECONDS}
				onTimeChange={(range) =>
					onChange(
						range.presetValue
							? { timePreset: range.presetValue, startTime: undefined, endTime: undefined }
							: { startTime: range.startTime, endTime: range.endTime, timePreset: undefined },
					)
				}
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
		<Empty className="rounded-xl border border-dashed md:py-14">
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
