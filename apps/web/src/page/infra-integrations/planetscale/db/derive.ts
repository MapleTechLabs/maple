import {
	type BranchCandidate,
	type BranchResolution,
	mergeBranchCandidates,
	orderBranches,
	resolveSelectedBranch,
} from "../../../../components/infra/planetscale/branch-selection"
import { metricsNeverCollected } from "../../../../components/integrations/planetscale-setup-steps"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import { chartBucketSeconds } from "../../../../charts/infra-metric-series"
import type { ChartEventMarker, EventTone } from "../../../../charts/event-marker-spec"
import type { TimeWindow } from "../../../../data/time-range"
import type { EpochWindowInput, EventEntry, TimeseriesInput } from "../data"
import { filtersFromSearch, type PlanetScaleFilters, soleSelectedBranch } from "../filters"
import type { LocalWindow, Model } from "./model"

// The page's derivations: the branch universe, the resolved scope and the request inputs.

const dataOf = <A, E>(slot: { readonly data: AsyncData.AsyncData<A, E> }): A | null =>
	Option.getOrNull(AsyncData.getData(slot.data))

/** `Result.builder(x).onSuccess(...).orElse(...)`: only a settled success counts. */
const successOf = <A, E>(slot: { readonly data: AsyncData.AsyncData<A, E> }): A | null =>
	AsyncData.isSuccess(slot.data) || AsyncData.isRefreshing(slot.data) ? dataOf(slot) : null

export const filtersOf = (model: Model): PlanetScaleFilters => filtersFromSearch(model.search)

export const databaseOf = (model: Model) =>
	successOf(model.databases)?.databases.find((db) => db.name === model.dbName) ?? null

export const statusOf = (model: Model) => successOf(model.status)

export const neverCollectedOf = (model: Model): boolean => {
	const status = statusOf(model)
	return status !== null && status.connected && metricsNeverCollected(status)
}

export const candidatesOf = (model: Model): ReadonlyArray<BranchCandidate> => {
	const status = statusOf(model)
	return orderBranches(
		mergeBranchCandidates(
			databaseOf(model)?.branches ?? [],
			successOf(model.branchStats) ?? [],
			status?.scrape_target?.include_branches ?? [],
			status?.scrape_target?.exclude_branches ?? [],
		),
	)
}

export const resolutionOf = (model: Model): BranchResolution =>
	resolveSelectedBranch(candidatesOf(model), soleSelectedBranch(filtersOf(model)) ?? undefined)

export const selectedBranchOf = (model: Model): BranchCandidate | null => {
	const resolution = resolutionOf(model)
	return resolution.kind === "resolved" ? resolution.branch : null
}

const withBranch = <A extends object>(input: A, branch: string | undefined): A =>
	branch === undefined ? input : { ...input, branch }

export const timeseriesInputOf = (model: Model, window: TimeWindow): TimeseriesInput =>
	withBranch(
		{
			database: model.dbName,
			startTime: window.startTime,
			endTime: window.endTime,
			bucketSeconds: chartBucketSeconds(window.startTime, window.endTime),
		},
		selectedBranchOf(model)?.name,
	)

/** `warehouseTimeToMs`: Query Insights reads it as UTC. */
const utcMs = (value: string) => new Date(`${value.replace(" ", "T")}Z`).getTime()

/** The local epochs come from `ResolveWindow`, which reads the browser zone. */
export const eventsInputOf = (model: Model, window: LocalWindow): EpochWindowInput =>
	withBranch(
		{ database: model.dbName, startTime: window.startMs, endTime: window.endMs },
		selectedBranchOf(model)?.name,
	)

export const insightsInputOf = (model: Model, window: TimeWindow): EpochWindowInput => ({
	...withBranch(
		{ database: model.dbName, startTime: utcMs(window.startTime), endTime: utcMs(window.endTime) },
		selectedBranchOf(model)?.name,
	),
	limit: 12,
})

// The PlanetScale events vocabulary: tone, short label and chart placement per event.

type Presentation = Readonly<{ tone: EventTone; short: string; onChart: boolean }>

const DEFAULT_PRESENTATION: Presentation = { tone: "neutral", short: "Event", onChart: false }

const PRESENTATION = new Map<string, Presentation>([
	["deploy_request.opened", { tone: "neutral", short: "DR opened", onChart: false }],
	["deploy_request.queued", { tone: "neutral", short: "DR queued", onChart: false }],
	["deploy_request.in_progress", { tone: "neutral", short: "Deploying", onChart: true }],
	["deploy_request.pending_cutover", { tone: "neutral", short: "Cutover", onChart: true }],
	["deploy_request.schema_applied", { tone: "neutral", short: "Deploy", onChart: true }],
	["deploy_request.errored", { tone: "crit", short: "Deploy failed", onChart: true }],
	["deploy_request.reverted", { tone: "warn", short: "Reverted", onChart: true }],
	["deploy_request.closed", { tone: "neutral", short: "DR closed", onChart: false }],
	["branch.ready", { tone: "neutral", short: "Ready", onChart: false }],
	["branch.sleeping", { tone: "neutral", short: "Asleep", onChart: false }],
	["branch.primary_promoted", { tone: "warn", short: "Promoted", onChart: true }],
	["branch.start_maintenance", { tone: "warn", short: "Maintenance", onChart: true }],
	["branch.out_of_memory", { tone: "crit", short: "OOM", onChart: true }],
	["branch.anomaly", { tone: "crit", short: "Anomaly", onChart: true }],
	["cluster.storage", { tone: "warn", short: "Storage", onChart: true }],
	["keyspace.storage", { tone: "warn", short: "Storage", onChart: true }],
	["database.access_request", { tone: "neutral", short: "Access request", onChart: false }],
])

export const presentEvent = (eventType: string): Presentation =>
	PRESENTATION.get(eventType) ?? DEFAULT_PRESENTATION

export const eventsToChartMarkers = (events: ReadonlyArray<EventEntry>): ReadonlyArray<ChartEventMarker> =>
	events.flatMap((event) => {
		const presentation = presentEvent(event.eventType)
		return presentation.onChart
			? [
					{
						id: event.id,
						at: new Date(event.occurredAt).toISOString(),
						label: presentation.short,
						tone: presentation.tone,
					},
				]
			: []
	})
