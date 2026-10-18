import { Duration, Effect, Option, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import { resolveWindow, type TimeWindow } from "../../../data/time-range"
import { AppRoute, hrefOf } from "../../../route"
import * as FilterSections from "../../../ui/filters/filter-sections"
import { type PageContext, PageOutMessage, type PageReturn, pickCommands } from "../../contract"
import { SignalPresenceData } from "../../kit/signal-presence"
import * as TimeRangePicker from "../../kit/time-range-picker"
import type { Resources } from "../../../platform/resources"
import {
	type BaselineInput,
	FetchAnomalies,
	FetchBaseline,
	FetchCommitMessages,
	FetchFacets,
	FetchOverview,
	FetchSparklines,
	LoadSignalPresence,
	type OverviewInput,
	ResolveWindow,
} from "./command"
import { commitsKey, displayedServices, healthSummary, isServiceHealth, type Search } from "./derive"
import { type Facet, Message, type RequestMode } from "./message"
import { IncidentsData, type Model } from "./model"
import {
	clickedCopySha,
	commitCardMessage,
	completedCommitDetail,
	copyMessage,
	elapsedCommitArm,
	initOverlays,
	rowTooltipMessage,
} from "./update-overlays"

type Return = PageReturn<Model, Message>

/** The list's default window ("12h" lists, `DashboardPage`'s `defaultPreset`). */
export const DEFAULT_PRESET = "12h"
/** `PageRefreshProvider`: how long Reload shows its pending spinner. */
const RELOAD_SPIN = Duration.millis(600)

export const CompleteReloadSpin = Command.define("CompleteServicesReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) => Effect.as(Effect.sleep(RELOAD_SPIN), Message.CompletedReloadSpin({ version })),
})

// REQUESTS

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

/** `applyGlobalNamespace(input, "top")`: the pin overrides the URL's namespace filters. */
const withPin = <
	A extends {
		readonly namespaces?: ReadonlyArray<string>
		readonly excludedNamespaces?: ReadonlyArray<string>
	},
>(
	input: A,
	pinnedNamespace: string | null,
): A =>
	pinnedNamespace === null
		? input
		: { ...input, namespaces: [pinnedNamespace], excludedNamespaces: undefined }

export const overviewInput = (
	search: Search,
	window: TimeWindow,
	pinnedNamespace: string | null,
): OverviewInput =>
	withPin(
		{
			startTime: window.startTime,
			endTime: window.endTime,
			environments: search.environments,
			namespaces: search.namespaces,
			commitShas: search.commitShas,
			excludedEnvironments: search.excludedEnvironments,
			excludedNamespaces: search.excludedNamespaces,
			excludedCommitShas: search.excludedCommitShas,
		},
		pinnedNamespace,
	)

type Step = Readonly<{
	patch: Partial<Model>
	commands: ReadonlyArray<Command.Command<Message, never, Resources>>
}>

/** One `Keyed.request`: `Some` writes the slot and returns its fetch (S6). */
const keyed = <A, E>(
	slot: Keyed.Keyed<A, E>,
	key: string,
	mode: Keyed.RequestMode,
	write: (next: Keyed.Keyed<A, E>) => Partial<Model>,
	fetch: (key: string) => Command.Command<Message, never, Resources>,
): Step =>
	Option.match(Keyed.request(slot, key, mode), {
		onNone: () => ({ patch: {}, commands: [] }),
		onSome: (next) => ({ patch: write(next), commands: [fetch(key)] }),
	})

const applySteps = (model: Model, steps: ReadonlyArray<Step>): Return => ({
	model: steps.reduce<Model>((next, step) => ({ ...next, ...step.patch }), model),
	commands: steps.flatMap((step) => step.commands),
})

const facetsStep = (model: Model, context: PageContext, window: TimeWindow, mode: RequestMode): Step =>
	keyed(
		model.facets,
		requestKey(context.orgId, "getServicesFacets", { data: window }),
		mode,
		(facets) => ({ facets }),
		(key) => FetchFacets({ key, window }),
	)

/** Every query the page reads, keyed like apps/web's atoms, for the resolved window. */
const requestAll = (model: Model, context: PageContext, window: TimeWindow, mode: RequestMode): Return => {
	const org = context.orgId
	const input = overviewInput(model.search, window, context.pinnedNamespace)
	const baselineInput = withPin<BaselineInput>(
		{ rangeStartTime: window.startTime, environments: model.search.environments },
		context.pinnedNamespace,
	)
	return applySteps({ ...model, window }, [
		keyed(
			model.overview,
			requestKey(org, "getServiceOverview", { data: input }),
			mode,
			(overview) => ({ overview }),
			(key) => FetchOverview({ key, input }),
		),
		keyed(
			model.sparklines,
			requestKey(org, "getCustomChartServiceSparklines", { data: input }),
			mode,
			(sparklines) => ({ sparklines }),
			(key) => FetchSparklines({ key, input }),
		),
		facetsStep(model, context, window, mode),
		keyed(
			model.baseline,
			requestKey(org, "getServiceHealthBaseline", { data: baselineInput }),
			mode,
			(baseline) => ({ baseline }),
			(key) => FetchBaseline({ key, input: baselineInput }),
		),
		keyed(
			model.anomalies,
			requestKey(org, "anomalies.serviceCounts", { status: "open" }),
			mode,
			(anomalies) => ({ anomalies }),
			(key) => FetchAnomalies({ key }),
		),
	])
}

/** Requests that follow the loaded data: the commit messages of the deploys on screen (`CommitMessagesProvider`). */
const followData =
	(context: PageContext) =>
	(result: Return): Return => {
		const { model } = result
		const overview = AsyncData.getData(model.overview.data)
		if (Option.isNone(overview) || !model.hasPaintedTable) return result
		const summary = summaryOf(model)
		const services = displayedServices(overview.value, summary, model.search)
		const shas = commitsKey(services)
		const commits =
			shas === ""
				? Option.none()
				: Option.map(
						Keyed.request(
							model.commitMessages,
							requestKey(context.orgId, "vcsCommitDetails", shas),
							"Load",
						),
						(commitMessages) => ({
							patch: { commitMessages },
							command: FetchCommitMessages({
								key: requestKey(context.orgId, "vcsCommitDetails", shas),
								shas,
							}),
						}),
					)
		return {
			model: {
				...model,
				...Option.match(commits, { onNone: () => ({}), onSome: ({ patch }) => patch }),
			},
			commands: [
				...(result.commands ?? []),
				...Option.match(commits, { onNone: () => [], onSome: ({ command }) => [command] }),
			],
			outMessage: result.outMessage,
		}
	}

/** The health summary, once the overview, incidents and anomalies have all loaded. */
export const summaryOf = (model: Model) => {
	const overview = AsyncData.getData(model.overview.data)
	const incidents = AsyncData.getData(model.incidents)
	const anomalies = AsyncData.getData(model.anomalies.data)
	return Option.isSome(overview) && Option.isSome(incidents) && Option.isSome(anomalies)
		? healthSummary(overview.value, incidents.value, anomalies.value, model.nowMs)
		: undefined
}

/** `rowRevision` after a slot settled: a new result is a new prop for every row. */
const bumped = <A, E>(model: Model, before: Keyed.Keyed<A, E>, after: Keyed.Keyed<A, E>): number =>
	before === after ? model.rowRevision : model.rowRevision + 1

// NAVIGATION

/** The row's `goToDetail`: the service in its environment, the window carried. */
const serviceHref = (model: Model, serviceName: string, environment: string): string =>
	hrefOf(
		AppRoute.Service({
			serviceName,
			search: {
				startTime: model.search.startTime,
				endTime: model.search.endTime,
				timePreset: model.search.timePreset,
				environments: [environment],
			},
		}),
	)

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.Services({ search })),
		isReplace: false,
	}),
})

const EXCLUDED_OF = {
	environments: "excludedEnvironments",
	namespaces: "excludedNamespaces",
	commitShas: "excludedCommitShas",
} as const satisfies Record<Facet, string>

/** `updateFilter`: an empty list leaves the URL. */
const listOrUndefined = (values: ReadonlyArray<string>) => (values.length === 0 ? undefined : values)

/** `toggleOption`: include and exclude are exclusive per value. */
const toggledFacet = (search: Search, facet: Facet, name: string): Search => {
	const selected = search[facet] ?? []
	const excluded = search[EXCLUDED_OF[facet]] ?? []
	return {
		...search,
		[EXCLUDED_OF[facet]]: excluded.includes(name)
			? listOrUndefined(excluded.filter((v) => v !== name))
			: search[EXCLUDED_OF[facet]],
		[facet]: listOrUndefined(
			selected.includes(name) ? selected.filter((v) => v !== name) : [...selected, name],
		),
	}
}

const excludedFacet = (search: Search, facet: Facet, name: string): Search => {
	const selected = search[facet] ?? []
	const excluded = search[EXCLUDED_OF[facet]] ?? []
	return {
		...search,
		[facet]: selected.includes(name)
			? listOrUndefined(selected.filter((v) => v !== name))
			: search[facet],
		[EXCLUDED_OF[facet]]: listOrUndefined(
			excluded.includes(name) ? excluded.filter((v) => v !== name) : [...excluded, name],
		),
	}
}

const windowOnly = (search: Search): Search => ({
	startTime: search.startTime,
	endTime: search.endTime,
	timePreset: search.timePreset,
})

// ENTRY POINTS

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		window: null,
		nowMs: 0,
		refreshVersion: 0,
		isReloading: false,
		overview: Keyed.idle(),
		sparklines: Keyed.idle(),
		rowRevision: 0,
		facets: Keyed.idle(),
		baseline: Keyed.idle(),
		anomalies: Keyed.idle(),
		incidents: IncidentsData.Loading(),
		hasPaintedTable: false,
		commitMessages: Keyed.idle(),
		presence: SignalPresenceData.Idle(),
		...initOverlays(),
		filterSections: FilterSections.init(),
		timePicker: TimeRangePicker.init("services-time-range"),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
	}
	return {
		model,
		commands: [
			resolveCommand(model, context, "Load"),
			Command.mapMessage(FilterSections.ReadRemembered(), (message) =>
				Message.GotFilterSectionsMessage({ message }),
			),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

/** The search changed (a filter, the window, grouping): re-resolve and re-request. */
/**
 * `servicesRouteAtoms(search)`, warmed on link intent: the facets, overview and sparklines for the
 * snapped window. Built from search alone, so the namespace pin is not applied (legacy's loader).
 */
export const preload = (route: { readonly search: Search }, context: PageContext, nowMs: number) => {
	const { model } = init(route, context)
	const window = resolveWindow(
		{
			startTime: model.search.startTime,
			endTime: model.search.endTime,
			preset: model.search.timePreset ?? DEFAULT_PRESET,
			snap: true,
			timeZone: context.timeZone,
		},
		nowMs,
	)
	return pickCommands(requestAll(model, { ...context, pinnedNamespace: null }, window, "Load"), [
		FetchOverview.name,
		FetchSparklines.name,
		FetchFacets.name,
	])
}

export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return => {
	if (searchHref(model.search) === searchHref(route.search)) return { model }
	const next = { ...model, search: route.search, rowRevision: model.rowRevision + 1 }
	// After a Reload the mount keeps resolving unsnapped (`refreshVersion > 0`), like legacy.
	return {
		model: next,
		commands: [resolveCommand(next, context, model.refreshVersion === 0 ? "Load" : "Refresh")],
	}
}

const searchHref = (search: Search) => hrefOf(AppRoute.Services({ search }))

export const contextChanged = (model: Model, context: PageContext): Return =>
	model.window === null ? { model } : followData(context)(requestAll(model, context, model.window, "Load"))

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			followData(context)(requestAll({ ...model, nowMs }, context, window, mode)),
		CompletedFetchOverview: ({ key, result }) => {
			const overview = Keyed.accept(model.overview, key, result)
			return followData(context)({
				model: { ...model, overview, rowRevision: bumped(model, model.overview, overview) },
			})
		},
		CompletedFetchSparklines: ({ key, result }) => {
			const sparklines = Keyed.accept(model.sparklines, key, result)
			return {
				model: { ...model, sparklines, rowRevision: bumped(model, model.sparklines, sparklines) },
			}
		},
		CompletedFetchFacets: ({ key, result }) => ({
			model: { ...model, facets: Keyed.accept(model.facets, key, result) },
		}),
		CompletedFetchBaseline: ({ key, result }) => {
			const baseline = Keyed.accept(model.baseline, key, result)
			return { model: { ...model, baseline, rowRevision: bumped(model, model.baseline, baseline) } }
		},
		CompletedFetchAnomalies: ({ key, result }) =>
			followData(context)({
				model: { ...model, anomalies: Keyed.accept(model.anomalies, key, result) },
			}),
		CompletedFetchCommitMessages: ({ key, result }) => ({
			model: { ...model, commitMessages: Keyed.accept(model.commitMessages, key, result) },
		}),
		PaintedTable: () =>
			model.hasPaintedTable
				? { model }
				: followData(context)({ model: { ...model, hasPaintedTable: true } }),
		// `useSignalPresence` mounts with the empty state, so the "unknown" copy paints first.
		PaintedEmptyState: () =>
			AsyncData.isIdle(model.presence)
				? {
						model: { ...model, presence: SignalPresenceData.Loading() },
						commands: [LoadSignalPresence()],
					}
				: { model },
		CompletedLoadSignalPresence: ({ result }) => ({
			model: { ...model, presence: AsyncData.settle(model.presence, result) },
		}),
		UpdatedIncidents: ({ orgId, incidents }) =>
			orgId === context.orgId
				? followData(context)({
						model: { ...model, incidents: IncidentsData.Success({ data: incidents }) },
					})
				: { model },
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		ClickedReload: () => {
			const reloaded = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
			return {
				model: reloaded,
				commands: [
					resolveCommand(reloaded, context, "Refresh"),
					CompleteReloadSpin({ version: reloaded.refreshVersion }),
				],
			}
		},
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		ClickedRetryFacets: () =>
			model.window === null
				? { model }
				: applySteps(model, [facetsStep(model, context, model.window, "Refresh")]),
		ToggledFacetOption: ({ facet, name }) => navigate(model, toggledFacet(model.search, facet, name)),
		ClickedOnlyFacetOption: ({ facet, name }) =>
			navigate(model, { ...model.search, [facet]: [name], [EXCLUDED_OF[facet]]: undefined }),
		ClickedExcludeFacetOption: ({ facet, name }) =>
			navigate(model, excludedFacet(model.search, facet, name)),
		// Single-select on a multi-select control: the newly ticked value wins, re-unticking clears.
		ToggledHealthOption: ({ name }) =>
			navigate(model, {
				...model.search,
				health: name !== model.search.health && isServiceHealth(name) ? name : undefined,
			}),
		ClickedClearAllFilters: () => navigate(model, windowOnly(model.search)),
		ClickedClearServiceFilters: () =>
			navigate(model, { ...windowOnly(model.search), groupBy: model.search.groupBy }),
		ClickedGroupBy: ({ groupBy }) =>
			groupBy === model.search.groupBy ? { model } : navigate(model, { ...model.search, groupBy }),
		ClickedServiceRow: ({ serviceName, environment }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({
				url: serviceHref(model, serviceName, environment),
				isReplace: false,
			}),
		}),
		GotFilterSectionsMessage: ({ message }) => {
			const next = FilterSections.update(model.filterSections, message)
			return {
				model: { ...model, filterSections: next.model },
				commands: Command.mapMessages(next.commands, (inner) =>
					Message.GotFilterSectionsMessage({ message: inner }),
				),
			}
		},
		GotSparklineMessage: () => ({ model }),
		GotRowTooltipMessage: ({ tooltip, message }) => rowTooltipMessage(model, tooltip, message),
		GotCommitCardMessage: ({ message }) => commitCardMessage(model, message),
		ElapsedCommitArm: ({ sha, generation }) => elapsedCommitArm(model, sha, generation),
		CompletedFetchCommitDetail: ({ sha, result }) => completedCommitDetail(model, sha, result),
		ClickedCopyCommitSha: ({ sha, serviceName, environment }) =>
			clickedCopySha(model, sha, serviceHref(model, serviceName, environment)),
		GotCopyMessage: ({ message }) => copyMessage(model, message),
		ClickedResetTimeRange: () =>
			navigate(model, {
				...model.search,
				startTime: undefined,
				endTime: undefined,
				timePreset: DEFAULT_PRESET,
			}),
		ClickedClearNamespacePin: () => ({
			model,
			outMessage: PageOutMessage.RequestedNamespacePin({ maybeNamespace: Option.none() }),
		}),
		RemovedFilterChip: ({ param }) => navigate(model, { ...model.search, [param]: undefined }),
		GotTimePickerMessage: ({ message: inner }) => {
			const next = TimeRangePicker.update(model.timePicker, inner)
			const lifted = {
				model: { ...model, timePicker: next.model },
				commands: Command.mapMessages(next.commands, (picker) =>
					Message.GotTimePickerMessage({ message: picker }),
				),
			}
			// `applyTimeRangeSearch` with a preset: the absolute bounds leave the URL.
			return next.outMessage === undefined
				? lifted
				: {
						...lifted,
						outMessage: PageOutMessage.RequestedNavigation({
							url: hrefOf(
								AppRoute.Services({
									search: {
										...model.search,
										startTime: undefined,
										endTime: undefined,
										timePreset: next.outMessage.presetValue,
									},
								}),
							),
							isReplace: false,
						}),
					}
		},
	})
