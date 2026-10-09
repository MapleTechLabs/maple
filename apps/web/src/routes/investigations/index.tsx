import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { useMemo } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Exit, Schema } from "effect"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import type { V2Investigation } from "@maple/domain/http/v2"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { ToolbarSearch, ToolbarStat, ToolbarStats } from "@maple/ui/components/toolbar"
import { FilteredEmpty } from "@/components/common/filtered-empty"
import { toEpochMs } from "@maple/ui/lib/time-format"

import { DocsLink } from "@/components/common/docs-link"
import { ResultView } from "@/components/common/result-view"
import { ListToolbar } from "@/components/common/list-toolbar"
import { PageHero } from "@/components/common/page-hero"
import { ConnectionIcon } from "@/components/icons"
import { useSignalPresence } from "@/hooks/use-signal-presence"
import { useAsyncAction } from "@/hooks/use-mutation-action"

import {
	investigationKindKey,
	matchesQuery,
	sortInvestigations,
	type InvestigationKindKey,
	type InvestigationSortKey,
} from "@/components/investigations/investigation-display"
import {
	InvestigationTable,
	InvestigationTableSkeleton,
} from "@/components/investigations/investigation-table"
import { InvestigateBar } from "@/components/investigations/investigate-bar"
import { DashboardPage } from "@/components/layout/dashboard-page"
import { Panel } from "@maple/ui/components/ui/panel"
import { showErrorToast } from "@/lib/error-toast"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import { MapleApiV2AtomClient, retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { retainedInternalQuery } from "@/lib/services/common/internal-atom-client"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"

type HubView = "active" | "history"

const searchSchema = Schema.Struct({
	view: Schema.optional(Schema.Literals(["active", "history"])),
	kind: Schema.optional(Schema.Literals(["alert", "error", "anomaly", "question", "verification"])),
	sort: Schema.optional(Schema.Literals(["updated", "severity", "confidence"])),
	dir: Schema.optional(Schema.Literals(["asc", "desc"])),
	q: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/investigations/")({
	component: InvestigationsHub,
	validateSearch: Schema.toStandardSchemaV1(searchSchema),
})

const PAGE_SIZE = 100

const ACTIVE_STATUSES: ReadonlyArray<V2Investigation["status"]> = ["investigating", "diagnosed"]

const isActive = (investigation: V2Investigation) => ACTIVE_STATUSES.includes(investigation.status)

/**
 * `all` is a filter value, not a kind — it only exists so the trigger has
 * something to show when nothing is filtered.
 */
const KIND_FILTER_LABEL: Record<InvestigationKindKey | "all", string> = {
	all: "All kinds",
	alert: "Alerts",
	error: "Errors",
	anomaly: "Anomalies",
	question: "Questions",
	verification: "Fix checks",
} satisfies Record<InvestigationKindKey | "all", string>

const KIND_FILTER_VALUES = Object.keys(KIND_FILTER_LABEL) as ReadonlyArray<InvestigationKindKey | "all">

const kindFilterLabel = (value: unknown): string =>
	typeof value === "string" && value in KIND_FILTER_LABEL
		? KIND_FILTER_LABEL[value as InvestigationKindKey | "all"]
		: KIND_FILTER_LABEL.all

/**
 * Sorting moved off the column headers, because the list no longer has any. Each
 * option is a `key:direction` pair so the control reads as an intent ("Most
 * severe") rather than a field plus a separate direction toggle.
 */
const SORT_OPTIONS = [
	{ value: "updated:desc", label: "Newest first" },
	{ value: "updated:asc", label: "Oldest first" },
	{ value: "severity:desc", label: "Most severe" },
	{ value: "confidence:desc", label: "Most confident" },
] as const

const sortLabel = (value: unknown): string =>
	SORT_OPTIONS.find((option) => option.value === value)?.label ?? SORT_OPTIONS[0].label

function InvestigationsHub() {
	const navigate = useNavigate({ from: Route.fullPath })
	const search = Route.useSearch()
	const view: HubView = search.view ?? "active"
	const sortKey: InvestigationSortKey = search.sort ?? "updated"
	const sortDirection = search.dir ?? "desc"
	const query = search.q ?? ""
	const isFiltered = query.trim().length > 0 || search.kind !== undefined

	const listQuery = retainedQueryV2("investigations", "list", {
		query: { limit: PAGE_SIZE },
		reactivityKeys: ["investigations"],
	})
	const result = useAtomValue(listQuery)
	const refresh = useAtomRefresh(listQuery)
	// The hub is where someone stands when they ask "why is nothing being
	// investigated?", so the answer has to be here rather than three clicks away
	// in settings.
	// Non-admins cannot change these ceilings, so the action would be a dead end —
	// the settings section renders nothing for them.
	const isOrgAdmin = useIsOrgAdmin()
	const budget = Result.builder(
		useAtomValue(
			retainedInternalQuery("aiTriage", "getSettings", { reactivityKeys: ["aiTriageSettings"] }),
		),
	)
		.onSuccess((value) => value)
		.orElse(() => null)
	const create = useAtomSet(MapleApiV2AtomClient.mutation("investigations", "create"), {
		mode: "promiseExit",
	})

	const page = Result.builder(result)
		.onSuccess((response) => response.data)
		.orElse((): ReadonlyArray<V2Investigation> => [])
	const hasMore = Result.builder(result)
		.onSuccess((response) => response.has_more)
		.orElse(() => false)

	// The list endpoint filters by a single status, but each tab spans two, so the
	// split happens here — which is also what lets the tabs carry counts.
	const activeCount = useMemo(() => page.filter(isActive).length, [page])
	const investigations = useMemo(() => {
		const inView = page.filter((investigation) =>
			view === "active" ? isActive(investigation) : !isActive(investigation),
		)
		const filtered = inView.filter(
			(investigation) =>
				(search.kind === undefined || investigationKindKey(investigation.subject) === search.kind) &&
				matchesQuery(investigation, query),
		)
		return sortInvestigations(filtered, sortKey, sortDirection)
	}, [page, view, search.kind, query, sortKey, sortDirection])

	const [handleCreate, creating] = useAsyncAction(async (title: string) => {
		const created = await create({
			payload: {
				subject: { type: "freeform", title, prompt: title, context_refs: [] },
				snapshot: {
					title,
					scope: null,
					status: "open",
					severity: null,
					facts: [],
					references: [],
					incidentStartedAt: null,
					incidentEndedAt: null,
				},
			},
			reactivityKeys: ["investigations"],
		})
		if (Exit.isSuccess(created)) {
			void navigate({ to: "/investigations/$id", params: { id: created.value.id } })
		} else {
			showErrorToast(created)
		}
	})

	// Nothing at all — not "nothing matching your filters". The hero belongs to a
	// workspace that has never run one, and it replaces the whole page rather than
	// sitting inside an empty table shell.
	const isFirstRun = Result.isSuccess(result) && page.length === 0

	const toolbar = (
		<ListToolbar
			tabs={[
				{ value: "active", label: "Active", count: activeCount },
				{ value: "history", label: "History", count: page.length - activeCount },
			]}
			active={view}
			label="Filter investigations"
			onChange={(value) =>
				void navigate({
					search: (prev) => ({ ...prev, view: value === "active" ? undefined : value }),
				})
			}
			countNoun={["investigation", "investigations"]}
			// Honest about the page: with more rows on the server, this is what's
			// shown, not a total.
			countLabel={
				hasMore ? `Showing ${investigations.length} of the ${PAGE_SIZE} most recent` : undefined
			}
			totalCount={hasMore ? undefined : investigations.length}
			trailing={
				<>
					<TriageStrip investigations={page} />
					<Select
						value={search.kind ?? "all"}
						onValueChange={(value) =>
							void navigate({
								search: (prev) => ({
									...prev,
									kind: value === "all" ? undefined : (value as InvestigationKindKey),
								}),
							})
						}
					>
						<SelectTrigger size="sm" className="w-[122px]">
							{/* The trigger renders before the items register, so it
							    resolves its own label rather than echoing the value. */}
							<SelectValue>{kindFilterLabel}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{KIND_FILTER_VALUES.map((value) => (
								<SelectItem key={value} value={value}>
									{KIND_FILTER_LABEL[value]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select
						value={`${sortKey}:${sortDirection}`}
						onValueChange={(value) => {
							const [key, direction] = String(value).split(":")
							void navigate({
								search: (prev) => ({
									...prev,
									// Defaults drop out of the URL entirely.
									sort: key === "updated" ? undefined : (key as InvestigationSortKey),
									dir: direction === "desc" ? undefined : "asc",
								}),
							})
						}}
					>
						<SelectTrigger size="sm" className="w-[136px]">
							<SelectValue>{sortLabel}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{SORT_OPTIONS.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<ToolbarSearch
						query={query}
						onSearch={(value) => void navigate({ search: (prev) => ({ ...prev, q: value }) })}
						placeholder="Search subjects and findings"
						className="w-[200px]"
					/>
				</>
			}
		/>
	)

	return (
		<DashboardPage
			breadcrumbs={[{ label: "Investigations" }]}
			sticky={
				isFirstRun ? null : (
					<>
						{budget?.enabled && budget.ordinaryPaused ? (
							<BudgetExhaustedNotice
								priorityPaused={budget.priorityPaused}
								dimension={budget.pausedDimension}
								resumesAt={budget.resumesAt}
								canEditSettings={isOrgAdmin}
							/>
						) : null}
						<InvestigateBar onSubmit={handleCreate} busy={creating} />
					</>
				)
			}
		>
			{isFirstRun ? (
				<HubHero onSubmit={handleCreate} busy={creating} />
			) : (
				// `shrink-0`, or the flex column shrinks this below its content height and
				// `overflow-hidden` clips the rows the scroller then thinks it doesn't need to scroll to.
				<Panel className="shrink-0">
					{toolbar}
					<ResultView
						result={result}
						loading={<InvestigationTableSkeleton />}
						errorTitle="Investigations could not be loaded"
						onRetry={refresh}
						isEmpty={() => investigations.length === 0}
						empty={
							<HubEmptyState
								view={view}
								filtered={isFiltered}
								onClear={() =>
									void navigate({
										search: (prev) => ({
											...prev,
											kind: undefined,
											q: undefined,
										}),
									})
								}
							/>
						}
					>
						{() => <InvestigationTable investigations={investigations} />}
					</ResultView>
				</Panel>
			)}
		</DashboardPage>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Budget notice
 * -----------------------------------------------------------------------------------------------*/

/**
 * Says why nothing new is starting.
 *
 * Not dismissible and not a toast: the condition lasts until UTC midnight and is
 * the direct answer to the question that brings someone to this page.
 *
 * The copy distinguishes three states because they are three different outages,
 * and the reassuring one is only true in the first. Telling an operator that
 * urgent incidents are still covered while the whole ceiling is spent is worse
 * than saying nothing — it sends them away from a real outage.
 */
function BudgetExhaustedNotice({
	priorityPaused,
	dimension,
	resumesAt,
	canEditSettings,
}: {
	priorityPaused: boolean
	dimension: "runs" | "runs_reserved" | "passes" | "passes_reserved" | null
	resumesAt: string | null
	canEditSettings: boolean
}) {
	const { effectiveTimezone } = useTimezonePreference()
	const resets =
		resumesAt === null
			? "."
			: `; it resets ${formatTimestampInTimezone(toEpochMs(resumesAt), { timeZone: effectiveTimezone, style: "range" })}.`
	// The runs ceiling counts investigations and the passes ceiling counts model
	// work; naming the wrong one sends the reader to raise a number that was never
	// the constraint.
	const spent =
		dimension === "runs" || dimension === "runs_reserved"
			? "Today's investigation limit is reached"
			: "Today's model budget is spent"
	return (
		<Alert variant="warn" className="mb-4">
			<AlertTitle className="text-foreground">
				{priorityPaused ? "Automatic triage paused" : "Automatic triage paused for routine incidents"}
			</AlertTitle>
			<AlertDescription>
				<span>
					{spent}
					{resets}{" "}
					{priorityPaused
						? "Nothing new will start until then."
						: "High and critical incidents still start."}
				</span>
			</AlertDescription>
			{canEditSettings ? (
				<AlertAction>
					<Button
						size="sm"
						variant="ghost"
						render={<Link to="/settings" search={{ tab: "automation" }} />}
					>
						Raise the limit
					</Button>
				</AlertAction>
			) : null}
		</Alert>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Triage strip
 * -----------------------------------------------------------------------------------------------*/

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Three toolbar numbers: what is running, what is waiting on a human, and what
 * the last day resolved. Derived from the fetched page rather than a
 * separate request — the page is the 100 most recent, which is the window these
 * counts are about anyway.
 */
function TriageStrip({ investigations }: { investigations: ReadonlyArray<V2Investigation> }) {
	const stats = useMemo(() => {
		const running = investigations.filter((entry) => entry.status === "investigating")
		const review = investigations.filter((entry) => entry.status === "diagnosed")
		const cutoff = Date.now() - DAY_MS
		const resolved = investigations.filter(
			(entry) => entry.status === "resolved" && toEpochMs(entry.updated_at) >= cutoff,
		)

		const critical = review.filter(
			(entry) => (entry.severity ?? entry.snapshot.severity) === "critical",
		).length

		return { running, review, resolved, critical }
	}, [investigations])

	return (
		<ToolbarStats className="hidden sm:flex">
			<ToolbarStat
				value={stats.running.length}
				label="investigating"
				tone={stats.running.length > 0 ? "info" : undefined}
			/>
			<ToolbarStat
				value={stats.review.length}
				label={stats.critical > 0 ? `to review (${stats.critical} critical)` : "to review"}
				tone={stats.review.length > 0 ? "warn" : undefined}
			/>
			<ToolbarStat
				value={stats.resolved.length}
				label="resolved in 24h"
			/>
		</ToolbarStats>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Empty states
 * -----------------------------------------------------------------------------------------------*/

const HERO_SUGGESTIONS = [
	"Why did checkout latency spike this afternoon?",
	"What changed before the last error burst?",
	"Which service is slowest right now, and why?",
]

/**
 * The first-run page. A workspace with no investigations has nothing to filter,
 * sort or triage, so the table chrome is all cost and no information — the whole
 * page becomes the invitation instead.
 */
function HubHero({ onSubmit, busy }: { onSubmit: (title: string) => void | Promise<void>; busy: boolean }) {
	const tracePresence = useSignalPresence("traces")
	return (
		<div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center gap-5 py-16">
			<Eyebrow className="text-primary">Investigations</Eyebrow>
			<PageHero
				title="Ask, and Maple goes and finds out."
				description="One agent reads the traces, logs and metrics around it, tests the likely explanations (deploys, dependencies, saturation, traffic) and comes back with a cause, the evidence for it, and what it ruled out."
			/>
			{tracePresence.status === "absent" && (
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
					<span>Investigations read your telemetry. Send traces first.</span>
					<Button
						size="sm"
						className="gap-2"
						render={<Link to="/settings" search={{ tab: "ingestion" }} />}
					>
						<ConnectionIcon size={14} />
						Set up tracing
					</Button>
					<DocsLink page="instrumentation">Setup guide</DocsLink>
				</div>
			)}
			<InvestigateBar
				onSubmit={onSubmit}
				busy={busy}
				accent
				placeholder="A service, a symptom, a question…"
			/>
			<ul className="flex flex-col gap-2">
				{HERO_SUGGESTIONS.map((suggestion) => (
					<li key={suggestion}>
						<button
							type="button"
							disabled={busy}
							onClick={() => void onSubmit(suggestion)}
							className="flex w-full items-center gap-3 rounded-md border bg-card px-3.5 py-2.5 text-left text-sm text-foreground transition-colors hover:border-ring hover:bg-accent/40 disabled:opacity-60"
						>
							<span aria-hidden className="shrink-0 text-muted-foreground">
								›
							</span>
							{suggestion}
						</button>
					</li>
				))}
			</ul>
			<div className="flex flex-wrap items-baseline gap-x-4 gap-y-2 text-sm text-muted-foreground">
				<p className="flex items-baseline gap-2">
					<StatusDot tone="custom" className="translate-y-[-2px] bg-primary" />
					When an alert rule fires, Maple opens an investigation on its own. Those land here too.
				</p>
				<Link to="/alerts/create" className="text-foreground underline-offset-4 hover:underline">
					Create an alert rule
				</Link>
				<DocsLink page="incidents" />
			</div>
		</div>
	)
}

function HubEmptyState({
	view,
	filtered,
	onClear,
}: {
	view: HubView
	filtered: boolean
	onClear: () => void
}) {
	if (filtered) {
		return (
			<FilteredEmpty
				noun="investigations"
				description={`Nothing in ${view === "active" ? "Active" : "History"} matches the kind or search you picked.`}
				onClear={onClear}
			/>
		)
	}
	return (
		<Empty>
			<EmptyHeader>
				<EmptyTitle>
					{view === "active" ? "Nothing under investigation" : "No finished investigations yet"}
				</EmptyTitle>
				<EmptyDescription>
					{view === "active"
						? "Start one above, or open an issue and choose Start investigation. When an alert rule fires, Maple opens one on its own."
						: "Investigations you resolve, and any that fail, stay here for reference."}
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<DocsLink page="incidents" />
			</EmptyContent>
		</Empty>
	)
}
