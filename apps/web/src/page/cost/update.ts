import {
	CostSourcesResponse,
	OPENROUTER_KEY_MAX_LENGTH,
	type VercelCostStatus,
	type VercelCostTeam,
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
	AddVercelCostSource,
	type BreakdownInput,
	CompleteReloadSpin,
	FetchCostBreakdown,
	FetchCostSources,
	FetchCostTimeseries,
	FetchCostTotals,
	FetchVercelCostStatus,
	ReadCostGrants,
	RemoveOpenRouterCostKey,
	RemoveVercelCostSource,
	ResolveWindow,
	SaveOpenRouterCostKey,
	type TimeseriesInput,
	type WindowInput,
} from "./command"
import {
	DEFAULT_GROUP_BY,
	groupByOf,
	hasSynced,
	isUnderADay,
	requestFilters,
	wholeDaySearch,
	sortOf,
	withoutFilter,
	withoutFilters,
} from "./derive"
import { Message } from "./message"
import { type AddStep, type Model, type RemovableProvider, type Search, vercelStepOf } from "./model"
import { COST_PROVIDERS } from "./providers"

type Return = PageReturn<Model, Message>
type Cmd = Command.Command<Message, never, Resources>

export const DEFAULT_PRESET: PresetValue = "30d"

/** The keys that get their own series in the chart; the rest fold into "Other". */
export const SERIES_LIMIT = 8
const BREAKDOWN_LIMIT = 100

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
	if (model.window === null || sources === undefined) return { model }
	// No source has cost: what was read for the sources there were is dropped. The reads are
	// keyed by the window, not by the sources, so it would stand in for the next source's cost.
	if (!hasSynced(sources.sources)) {
		return {
			model: { ...model, totals: Keyed.idle(), timeseries: Keyed.idle(), breakdown: Keyed.idle() },
		}
	}
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
	return applySteps<Model, Message>(model, [
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
		keyDraft: Field.init(),
		keyError: null,
		vercel: Keyed.idle(),
		vercelError: null,
		removeDialog: Dialog.init("cost-remove-source", "alert-dialog"),
		removeProvider: "openrouter",
		sourceWrite: "Idle",
	}
	return chain<Model, Message>(
		{
			model,
			commands: [
				resolveCommand(model, context, "Load"),
				LoadChartRuntime(),
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
const clearedKey = (model: Model): Model => ({
	...model,
	keyDraft: Field.init(),
	keyError: null,
	vercelError: null,
})

/**
 * The org's Vercel connection, read again each time the dialog turns to Vercel. The answer on
 * show is dropped first: the step never offers an add on a connection read before it was left,
 * and a read that fails says so. The key stays, so an older read in flight cannot answer.
 */
const requestVercelStatus = (model: Model, context: PageContext): Return =>
	applySteps<Model, Message>(model, [
		keyed(
			{ ...Keyed.idle<VercelCostStatus, LoadFailure>(), key: model.vercel.key },
			requestKey(context.orgId, "vercelCostStatus", {}),
			"Supersede",
			(vercel) => ({ vercel }),
			(key) => FetchVercelCostStatus({ key }),
		),
	])

/** The team on show, when it can be added: a token Vercel takes and no source yet. */
const addableVercelTeam = (model: Model): Option.Option<VercelCostTeam> =>
	Option.flatMap(AsyncData.getData(model.vercel.data), (status) => {
		const step = vercelStepOf(status)
		return step._tag === "Ready" ? Option.some(step.team) : Option.none()
	})

const openAdd = (model: Model, addStep: AddStep): Return =>
	model.sourceWrite !== "Idle"
		? { model }
		: liftAddDialog({ ...clearedKey(model), addStep }, Dialog.open(model.addDialog))

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
 * The list on show without the provider's source, which a removal just deleted: its row is gone
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

/** Whether the org has an OpenRouter source, which a saved key then replaces the key of. */
const hasOpenRouterSource = (model: Model): boolean =>
	Option.exists(AsyncData.getData(model.sources.data), ({ sources }) =>
		Arr.some(sources, (source) => source.provider === "openrouter"),
	)

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

/** A source was added or its key replaced: the dialog closes, and the page reads what it now has. */
const added = (model: Model, title: string, description: string, context: PageContext): Return =>
	withReread(
		{
			...liftAddDialog(
				clearedKey({ ...model, sourceWrite: "Settling" }),
				Dialog.close(model.addDialog),
			),
			outMessage: toast("success", title, description),
		},
		context,
	)

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
		ClickedAddOpenRouter: () => ({ model: { ...clearedKey(model), addStep: "openrouter" } }),
		ClickedAddVercel: () =>
			model.sourceWrite !== "Idle"
				? { model }
				: requestVercelStatus({ ...clearedKey(model), addStep: "vercel" }, context),
		CompletedLoadVercelStatus: ({ key, result }) => ({
			model: { ...model, vercel: Keyed.accept(model.vercel, key, result) },
		}),
		// The add names the team on show: one connected since is refused, not added in its place.
		ClickedConfirmAddVercel: () =>
			Option.match(model.sourceWrite === "Idle" ? addableVercelTeam(model) : Option.none(), {
				onNone: (): Return => ({ model }),
				onSome: (team): Return => ({
					model: { ...model, sourceWrite: "Saving", vercelError: null },
					commands: [AddVercelCostSource({ teamId: team.id })],
				}),
			}),
		// A refused add keeps the dialog open with Vercel's reason under the team.
		CompletedAddVercel: ({ result }) =>
			Result.match(result, {
				onFailure: (failure): Return => ({
					model: { ...model, sourceWrite: "Idle", vercelError: failureMessage(failure) },
				}),
				onSuccess: (): Return =>
					added(model, "Vercel added", "The first sync runs within a few minutes.", context),
			}),
		ClickedBackToProviders: () =>
			model.sourceWrite === "Idle" ? { model: { ...clearedKey(model), addStep: "pick" } } : { model },
		ClickedReplaceKey: () => openAdd(model, "openrouter"),
		// A save in flight keeps the dialog: its answer decides whether it closes.
		GotAddDialogMessage: ({ message: inner }) => {
			if (model.sourceWrite === "Saving") return { model }
			const step = Dialog.update(model.addDialog, inner)
			const lifted = liftAddDialog(model, step)
			return step.outMessage?._tag === "Closed"
				? { ...lifted, model: clearedKey(lifted.model) }
				: lifted
		},
		GotKeyDraftMessage: ({ message: inner }) =>
			model.sourceWrite === "Saving"
				? { model }
				: {
						model: {
							...model,
							keyDraft: Field.update(model.keyDraft, inner).model,
							// The refusal was about the key that was there.
							keyError: inner._tag === "ChangedValue" ? null : model.keyError,
						},
					},
		SubmittedKey: () => {
			const apiKey = Str.trim(model.keyDraft.value)
			if (apiKey === "" || model.sourceWrite !== "Idle") return { model }
			// The request refuses a longer key before it is sent, which would leave the save unanswered.
			if (apiKey.length > OPENROUTER_KEY_MAX_LENGTH) {
				return { model: { ...model, keyError: "That is too long to be an OpenRouter key." } }
			}
			return {
				model: { ...model, sourceWrite: "Saving", keyError: null },
				commands: [SaveOpenRouterCostKey({ apiKey })],
			}
		},
		// A refused key keeps the dialog open with the reason under the field.
		CompletedSaveKey: ({ result }) =>
			Result.match(result, {
				onFailure: (failure): Return => ({
					model: { ...model, sourceWrite: "Idle", keyError: failureMessage(failure) },
				}),
				onSuccess: (): Return =>
					hasOpenRouterSource(model)
						? added(
								model,
								"OpenRouter key replaced",
								"The next sync runs within a few minutes.",
								context,
							)
						: added(
								model,
								"OpenRouter added",
								"The first sync runs within a few minutes.",
								context,
							),
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
			model.sourceWrite !== "Idle"
				? { model }
				: {
						model: { ...model, sourceWrite: "Removing" },
						commands: [
							model.removeProvider === "vercel"
								? RemoveVercelCostSource()
								: RemoveOpenRouterCostKey(),
						],
					},
		CompletedRemoveKey: ({ result }) => removed(model, "openrouter", Result.getFailure(result), context),
		CompletedRemoveVercel: ({ result }) => removed(model, "vercel", Result.getFailure(result), context),
		...chartEnvHandlers(model),
	})
