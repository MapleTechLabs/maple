import {
	CostSourcesResponse,
	PLANETSCALE_COST_RECONNECT_CODE,
	type PlanetScaleCostStatus,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Option, Result, String as Str } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Chart from "@maple/views/charts/chart"
import { chartEnvHandlers } from "@maple/views/charts/chart-env"
import { LoadChartRuntime } from "@maple/views/charts/chart-runtime"
import * as Keyed from "@maple/views/data/keyed"
import { failureMessage, type LoadFailure } from "@maple/views/data/load-failure"
import { requestKey } from "@maple/views/data/request-key"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as FilterSections from "@maple/views/ui/filters/filter-sections"
import { isClerkAuthEnabled } from "../../platform/auth-mode"
import type { Resources } from "../../platform/resources"
import { AppRoute, hrefOf } from "../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import { applySteps, chain, keyed } from "../kit/keyed-step"
import { pickerStep } from "../kit/page-time"
import { routeWindowStep, snapModeOf } from "../kit/route-window"
import type { PresetValue } from "../kit/time-controls"
import * as TimeRangePicker from "../kit/time-range-picker"
import {
	type BreakdownInput,
	CompleteReloadSpin,
	FetchCostBreakdown,
	FetchCostFacets,
	type FacetsInput,
	FetchCostSources,
	FetchCostTimeseries,
	FetchCostTotals,
	AddPlanetScaleCostSource,
	FetchPlanetScaleCostStatus,
	ReadCostGrants,
	RemovePlanetScaleCostSource,
	ResolveWindow,
	type TimeseriesInput,
	type WindowInput,
} from "./command"
import {
	DEFAULT_GROUP_BY,
	facetFilters,
	perDimension,
	groupByOf,
	hasSourceOf,
	onlyFilter,
	toggledFilter,
	hasSynced,
	isUnderADay,
	requestFilters,
	wholeDaySearch,
	sortOf,
	withoutFilter,
	withoutFilters,
} from "./derive"
import { CREDENTIAL_SOURCES } from "./credential-sources"
import { Message } from "./message"
import { type AddStep, type Model, planetScaleStepOf, type Search } from "./model"
import { COST_PROVIDERS, type CredentialProvider, type RemovableProvider } from "./providers"

type Return = PageReturn<Model, Message>
type Cmd = Command.Command<Message, never, Resources>

export const DEFAULT_PRESET: PresetValue = "30d"

/** The keys that get their own series in the chart; the rest fold into "Other". */
export const SERIES_LIMIT = 8
const BREAKDOWN_LIMIT = 100
/** The values each rail section can offer, by cost. */
const FACET_LIMIT = 100

const resolveCommand = (model: Model, context: PageContext, mode: Keyed.RequestMode): Cmd =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.Cost({ search })),
		isReplace: false,
	}),
})

const requestSources = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	applySteps<Model, Message>(model, [
		keyed(
			model.sources,
			requestKey(context.orgId, "costSources", {}),
			mode,
			(sources) => ({ sources }),
			(key) => FetchCostSources({ key }),
		),
	])

/** The window's reads, once a source has cost to read: an org with none sends no warehouse query. */
const requestData = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	const sources = Option.getOrUndefined(AsyncData.getData(model.sources.data))
	if (model.window === null || sources === undefined || !hasSynced(sources.sources)) return { model }
	const filters = requestFilters(model.search)
	const window: WindowInput = {
		startTime: model.window.startTime,
		endTime: model.window.endTime,
		...(filters === undefined ? undefined : { filters }),
	}
	const groupBy = groupByOf(model.search)
	const timeseries: TimeseriesInput = { ...window, groupBy, limit: SERIES_LIMIT }
	// The order is the read's own: sorted by change, the top rows are the largest moves.
	const breakdown: BreakdownInput = {
		...window,
		groupBy,
		sortBy: sortOf(model.search),
		limit: BREAKDOWN_LIMIT,
	}
	const facets: FacetsInput = {
		startTime: model.window.startTime,
		endTime: model.window.endTime,
		filters: perDimension((dimension) => facetFilters(model.search, dimension)),
		limit: FACET_LIMIT,
	}
	return applySteps<Model, Message>(model, [
		keyed(
			model.facets,
			requestKey(context.orgId, "costFacets", { data: facets }),
			mode,
			(next) => ({ facets: next }),
			(key) => FetchCostFacets({ key, input: facets }),
		),
		keyed(
			model.totals,
			requestKey(context.orgId, "costTotals", { data: window }),
			mode,
			(totals) => ({ totals }),
			(key) => FetchCostTotals({ key, input: window }),
		),
		keyed(
			model.timeseries,
			requestKey(context.orgId, "costTimeseries", { data: timeseries }),
			mode,
			(next) => ({ timeseries: next }),
			(key) => FetchCostTimeseries({ key, input: timeseries }),
		),
		keyed(
			model.breakdown,
			requestKey(context.orgId, "costBreakdown", { data: breakdown }),
			mode,
			(next) => ({ breakdown: next }),
			(key) => FetchCostBreakdown({ key, input: breakdown }),
		),
	])
}

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const model: Model = {
		search: wholeDaySearch(route.search),
		window: null,
		nowMs: 0,
		sources: Keyed.idle(),
		totals: Keyed.idle(),
		timeseries: Keyed.idle(),
		breakdown: Keyed.idle(),
		facets: Keyed.idle(),
		filterSections: FilterSections.init(),
		timePicker: TimeRangePicker.init("cost-time-range"),
		chart: Chart.init(),
		themeColors: null,
		chartRuntime: { _tag: "Loading" },
		refreshVersion: 0,
		isReloading: false,
		// Without Clerk there are no roles: everyone may do everything.
		grants: isClerkAuthEnabled ? null : Policy.allPermissions,
		addDialog: Dialog.init("cost-add-source", "dialog"),
		addStep: "pick",
		credentialDraft: Field.init(),
		credentialError: null,
		planetscale: Keyed.idle(),
		planetscaleError: null,
		removeDialog: Dialog.init("cost-remove-source", "alert-dialog"),
		removeProvider: null,
		sourceWrite: "Idle",
	}
	return chain<Model, Message>(
		{
			model,
			commands: [
				resolveCommand(model, context, "Load"),
				LoadChartRuntime(),
				Command.mapMessage(FilterSections.ReadRemembered(), (message) =>
					Message.GotFilterSectionsMessage({ message }),
				),
				...(isClerkAuthEnabled ? [ReadCostGrants()] : []),
			],
		},
		(next) => requestSources(next, context, "Load"),
	)
}

const searchHref = (search: Search) => hrefOf(AppRoute.Cost({ search }))

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

const liftAddDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, addDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotAddDialogMessage({ message })),
})

const liftRemoveDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, removeDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotRemoveDialogMessage({ message }),
	),
})

/** Nothing typed and no refusal on show: how the dialog opens and what it leaves behind. */
const clearedCredential = (model: Model): Model => ({
	...model,
	credentialDraft: Field.init(),
	credentialError: null,
	planetscaleError: null,
})

/**
 * The org's PlanetScale connection, read again each time the dialog turns to PlanetScale. The
 * answer on show is dropped first: the step never offers an add on a connection read before it
 * was left, and a read that fails says so. The key stays, so an older read in flight cannot answer.
 */
const requestPlanetScaleStatus = (model: Model, context: PageContext): Return =>
	applySteps<Model, Message>(model, [
		keyed(
			{ ...Keyed.idle<PlanetScaleCostStatus, LoadFailure>(), key: model.planetscale.key },
			requestKey(context.orgId, "planetScaleCostStatus", {}),
			"Supersede",
			(planetscale) => ({ planetscale }),
			(key) => FetchPlanetScaleCostStatus({ key }),
		),
	])

/** The organization on show, when it can be added: a grant that reads invoices and no source yet. */
const addablePlanetScaleOrganization = (model: Model): Option.Option<string> =>
	Option.flatMap(AsyncData.getData(model.planetscale.data), (status) => {
		const step = planetScaleStepOf(status)
		return step._tag === "Ready" ? Option.some(step.organization) : Option.none()
	})

const openAdd = (model: Model, addStep: AddStep): Return =>
	model.sourceWrite !== "Idle"
		? { model }
		: liftAddDialog({ ...clearedCredential(model), addStep }, Dialog.open(model.addDialog))

/**
 * The sources and the window's reads again, after a write's own step: the reads name the org's
 * sources, so a removed one's cost would stay on the page until then. Superseding, so a reload
 * that started before the write cannot answer for them.
 */
const withReread = (step: Return, context: PageContext): Return =>
	chain<Model, Message>(
		chain<Model, Message>(step, (next) => requestSources(next, context, "Supersede")),
		(next) => requestData(next, context, "Supersede"),
	)

/**
 * The list on show without `provider`'s source, which a removal just deleted: its row is gone
 * at once, so no refresh, late or failed, leaves actions on a source that no longer exists.
 */
const withoutSourceOf = (model: Model, provider: RemovableProvider): Model => ({
	...model,
	sources: {
		...model.sources,
		data: AsyncData.map(
			model.sources.data,
			(response) =>
				new CostSourcesResponse({
					sources: Arr.filter(response.sources, (source) => source.provider !== provider),
				}),
		),
	},
})

/** Whether the org has `provider`'s source, which a saved credential then replaces the credential of. */
const hasSource = (model: Model, provider: CredentialProvider): boolean =>
	Option.exists(AsyncData.getData(model.sources.data), ({ sources }) => hasSourceOf(sources, provider))

/** A removal's answer: the dialog closes either way, and a removed source leaves the page at once. */
const removed = (
	model: Model,
	provider: RemovableProvider,
	failure: Option.Option<LoadFailure>,
	context: PageContext,
): Return => {
	const closed = liftRemoveDialog(
		Option.isNone(failure)
			? withoutSourceOf({ ...model, sourceWrite: "Settling" }, provider)
			: { ...model, sourceWrite: "Idle" },
		Dialog.close(model.removeDialog),
	)
	return Option.match(failure, {
		onSome: (reason): Return => ({
			...closed,
			outMessage: toast("error", "Couldn't remove the source", failureMessage(reason)),
		}),
		onNone: (): Return =>
			withReread(
				{ ...closed, outMessage: toast("success", `${COST_PROVIDERS[provider].name} removed`) },
				context,
			),
	})
}

export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return => {
	const search = wholeDaySearch(route.search)
	if (searchHref(model.search) === searchHref(search)) return { model }
	const next = { ...model, search }
	return routeWindowStep(model.search, search, {
		resolve: (): Return => ({
			model: next,
			commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))],
		}),
		requestAll: (mode) => requestData(next, context, mode),
	})
}

// The presets are whole days in the reader's time zone, so a changed zone moves the window:
// resolve it again, which then requests the data, and never re-request the old window.
export const contextChanged = (model: Model, context: PageContext): Return => ({
	model,
	commands: [resolveCommand(model, context, "Load")],
})

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			requestData({ ...model, window, nowMs }, context, mode),
		// The sources' answer decides whether there is anything to read; a failed one reads nothing.
		CompletedLoadSources: ({ key, result }) =>
			requestData(
				{
					...model,
					sources: Keyed.accept(model.sources, key, result),
					// The list read after a write is in: its rows are the real ones again.
					sourceWrite:
						model.sourceWrite === "Settling" && key === model.sources.key
							? "Idle"
							: model.sourceWrite,
				},
				context,
				"Load",
			),
		CompletedLoadTotals: ({ key, result }) => ({
			model: { ...model, totals: Keyed.accept(model.totals, key, result) },
		}),
		CompletedLoadTimeseries: ({ key, result }) => ({
			model: { ...model, timeseries: Keyed.accept(model.timeseries, key, result) },
		}),
		CompletedLoadBreakdown: ({ key, result }) => ({
			model: { ...model, breakdown: Keyed.accept(model.breakdown, key, result) },
		}),
		ClickedReload: () => {
			const reloaded = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
			return chain<Model, Message>(
				{
					model: reloaded,
					commands: [
						resolveCommand(reloaded, context, "Refresh"),
						CompleteReloadSpin({ version: reloaded.refreshVersion }),
						// A session read that failed left no grants: Reload asks again.
						...(isClerkAuthEnabled ? [ReadCostGrants()] : []),
					],
				},
				(next) => requestSources(next, context, "Refresh"),
			)
		},
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		ClickedResetTimeRange: () =>
			navigate(model, {
				...model.search,
				startTime: undefined,
				endTime: undefined,
				timePreset: undefined,
			}),
		// `Load` asks again only for a read that failed; one that answered keeps its data.
		ClickedRetry: () =>
			chain<Model, Message>(requestSources(model, context, "Load"), (next) =>
				requestData(next, context, "Load"),
			),
		// The defaults stay out of the URL.
		PickedGroupBy: ({ groupBy }) =>
			navigate(model, {
				...model.search,
				groupBy: groupBy === DEFAULT_GROUP_BY ? undefined : groupBy,
			}),
		ClickedSort: ({ sort }) =>
			navigate(model, { ...model.search, sort: sort === "cost" ? undefined : sort }),
		CompletedLoadFacets: ({ key, result }) => ({
			model: { ...model, facets: Keyed.accept(model.facets, key, result) },
		}),
		ToggledFacetValue: (filter) => navigate(model, toggledFilter(model.search, filter)),
		ClickedOnlyFacetValue: (filter) => navigate(model, onlyFilter(model.search, filter)),
		GotFilterSectionsMessage: ({ message: inner }) => {
			const next = FilterSections.update(model.filterSections, inner)
			return {
				model: { ...model, filterSections: next.model },
				commands: Command.mapMessages(next.commands ?? [], (sections) =>
					Message.GotFilterSectionsMessage({ message: sections }),
				),
			}
		},
		ClickedRemoveFilter: (filter) => navigate(model, withoutFilter(model.search, filter)),
		ClickedClearFilters: () => navigate(model, withoutFilters(model.search)),
		GotTimePickerMessage: ({ message: inner }) =>
			pickerStep(
				model,
				inner,
				(picker) => Message.GotTimePickerMessage({ message: picker }),
				// A typed or custom range of hours is refused the way one past the maximum is.
				(patch) =>
					isUnderADay(patch)
						? PageOutMessage.RequestedToast({
								type: "error",
								title: "Cost is read per whole day",
								description: "Pick a range of a day or more.",
							})
						: navigate(model, { ...model.search, ...patch }).outMessage,
				{ toastRejected: true },
			),
		GotChartMessage: ({ message: inner }) => {
			const next = Chart.update(model.chart, inner)
			return {
				model: { ...model, chart: next.model },
				commands: Command.mapMessages(next.commands ?? [], (chart) =>
					Message.GotChartMessage({ message: chart }),
				),
			}
		},
		CompletedReadGrants: ({ grants }) => ({ model: { ...model, grants } }),
		ClickedAddSource: () => openAdd(model, "pick"),
		PickedProvider: ({ provider }) => ({ model: { ...clearedCredential(model), addStep: provider } }),
		ClickedBackToProviders: () =>
			model.sourceWrite === "Idle"
				? { model: { ...clearedCredential(model), addStep: "pick" } }
				: { model },
		ClickedReplaceCredential: ({ provider }) => openAdd(model, provider),
		// A save in flight keeps the dialog: its answer decides whether it closes.
		GotAddDialogMessage: ({ message: inner }) => {
			if (model.sourceWrite === "Saving") return { model }
			const step = Dialog.update(model.addDialog, inner)
			const lifted = liftAddDialog(model, step)
			return step.outMessage?._tag === "Closed"
				? { ...lifted, model: clearedCredential(lifted.model) }
				: lifted
		},
		GotCredentialDraftMessage: ({ message: inner }) =>
			model.sourceWrite === "Saving"
				? { model }
				: {
						model: {
							...model,
							credentialDraft: Field.update(model.credentialDraft, inner).model,
							// The refusal was about the credential that was there.
							credentialError: inner._tag === "ChangedValue" ? null : model.credentialError,
						},
					},
		SubmittedCredential: () => {
			const secret = Str.trim(model.credentialDraft.value)
			if (
				secret === "" ||
				model.sourceWrite !== "Idle" ||
				model.addStep === "pick" ||
				model.addStep === "planetscale"
			) {
				return { model }
			}
			const source = CREDENTIAL_SOURCES[model.addStep]
			// The request refuses a longer one before it is sent, which would leave the save unanswered.
			if (secret.length > source.field.maxLength) {
				return { model: { ...model, credentialError: source.field.tooLong } }
			}
			return {
				model: { ...model, sourceWrite: "Saving", credentialError: null },
				commands: [source.save(secret)],
			}
		},
		// A refused credential keeps the dialog open with the reason under the field.
		CompletedSaveCredential: ({ provider, result }) =>
			Result.match(result, {
				onFailure: (failure): Return => ({
					model: { ...model, sourceWrite: "Idle", credentialError: failureMessage(failure) },
				}),
				onSuccess: (): Return => {
					const closed = liftAddDialog(
						clearedCredential({ ...model, sourceWrite: "Settling" }),
						Dialog.close(model.addDialog),
					)
					const source = CREDENTIAL_SOURCES[provider]
					const outMessage = hasSource(model, provider)
						? toast("success", source.replace.toast, "The next sync runs within a few minutes.")
						: toast("success", source.add.toast, "The first sync runs within a few minutes.")
					return withReread({ ...closed, outMessage }, context)
				},
			}),
		ClickedRemoveSource: ({ provider }) =>
			model.sourceWrite !== "Idle"
				? { model }
				: liftRemoveDialog({ ...model, removeProvider: provider }, Dialog.open(model.removeDialog)),
		GotRemoveDialogMessage: ({ message: inner }) =>
			model.sourceWrite === "Removing"
				? { model }
				: liftRemoveDialog(model, Dialog.update(model.removeDialog, inner)),
		ClickedConfirmRemove: () =>
			model.sourceWrite !== "Idle" || model.removeProvider === null
				? { model }
				: {
						model: { ...model, sourceWrite: "Removing" },
						commands: [
							model.removeProvider === "planetscale"
								? RemovePlanetScaleCostSource()
								: CREDENTIAL_SOURCES[model.removeProvider].delete(),
						],
					},
		CompletedRemoveCredential: ({ provider, result }) =>
			removed(model, provider, Result.getFailure(result), context),
		CompletedRemovePlanetScale: ({ result }) =>
			removed(model, "planetscale", Result.getFailure(result), context),
		ClickedAddPlanetScale: () =>
			model.sourceWrite !== "Idle"
				? { model }
				: requestPlanetScaleStatus({ ...clearedCredential(model), addStep: "planetscale" }, context),
		CompletedLoadPlanetScaleStatus: ({ key, result }) => ({
			model: { ...model, planetscale: Keyed.accept(model.planetscale, key, result) },
		}),
		// The add names the organization on show: one bound since is refused, not added in its place.
		ClickedConfirmAddPlanetScale: () =>
			Option.match(
				model.sourceWrite === "Idle" ? addablePlanetScaleOrganization(model) : Option.none(),
				{
					onNone: (): Return => ({ model }),
					onSome: (organization): Return => ({
						model: { ...model, sourceWrite: "Saving", planetscaleError: null },
						commands: [AddPlanetScaleCostSource({ organization })],
					}),
				},
			),
		// A refused add keeps the dialog open with the reason under the organization.
		CompletedAddPlanetScale: ({ result }) =>
			Result.match(result, {
				onFailure: (failure): Return => ({
					model: {
						...model,
						sourceWrite: "Idle",
						planetscaleError: {
							message: failureMessage(failure),
							needsReconnect: failure.code === PLANETSCALE_COST_RECONNECT_CODE,
						},
					},
				}),
				onSuccess: (): Return =>
					withReread(
						{
							...liftAddDialog(
								clearedCredential({ ...model, sourceWrite: "Settling" }),
								Dialog.close(model.addDialog),
							),
							outMessage: toast(
								"success",
								"PlanetScale added",
								"The first sync runs within a few minutes.",
							),
						},
						context,
					),
			}),
		...chartEnvHandlers(model),
	})
