import { CostSourcesResponse } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Option, Result, String as Str } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Chart from "@maple/views/charts/chart"
import { chartEnvHandlers } from "@maple/views/charts/chart-env"
import { LoadChartRuntime } from "@maple/views/charts/chart-runtime"
import * as Keyed from "@maple/views/data/keyed"
import { failureMessage } from "@maple/views/data/load-failure"
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
	type BreakdownInput,
	CompleteReloadSpin,
	FetchCostBreakdown,
	FetchCostSources,
	FetchCostTimeseries,
	FetchCostTotals,
	ReadCostGrants,
	ResolveWindow,
	type TimeseriesInput,
	type WindowInput,
} from "./command"
import {
	DEFAULT_GROUP_BY,
	groupByOf,
	hasSourceOf,
	hasSynced,
	isUnderADay,
	requestFilters,
	wholeDaySearch,
	sortOf,
	withoutFilter,
	withoutFilters,
} from "./derive"
import { CREDENTIAL_SOURCES, credentialSourceOf } from "./credential-sources"
import { Message } from "./message"
import type { AddStep, Model, Search } from "./model"
import type { CredentialProvider } from "./providers"

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
		credentialDraft: Field.init(),
		credentialIdentifiers: [],
		credentialError: null,
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

/** The plain fields of a step's provider: empty, or what its source says when one is being replaced. */
const identifierDrafts = (model: Model, addStep: AddStep): ReadonlyArray<Field.Model> => {
	if (addStep === "pick") return []
	const existing = Option.flatMap(AsyncData.getData(model.sources.data), ({ sources }) =>
		Arr.findFirst(sources, (source) => source.provider === addStep),
	)
	return Arr.map(credentialSourceOf(addStep).identifiers ?? [], (identifier) =>
		Field.init(
			Option.match(existing, {
				onNone: () => "",
				onSome: (replaced) => identifier.fromSource?.(replaced) ?? "",
			}),
		),
	)
}

/** The dialog on `addStep`, with nothing typed and no refusal on show: how it opens and what it leaves behind. */
const clearedCredential = (model: Model, addStep: AddStep = model.addStep): Model => ({
	...model,
	addStep,
	credentialDraft: Field.init(),
	credentialIdentifiers: identifierDrafts(model, addStep),
	credentialError: null,
})

const openAdd = (model: Model, addStep: AddStep): Return =>
	model.sourceWrite !== "Idle"
		? { model }
		: liftAddDialog(clearedCredential(model, addStep), Dialog.open(model.addDialog))

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
const withoutSourceOf = (model: Model, provider: CredentialProvider): Model => ({
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
		PickedProvider: ({ provider }) => ({ model: clearedCredential(model, provider) }),
		ClickedBackToProviders: () =>
			model.sourceWrite === "Idle" ? { model: clearedCredential(model, "pick") } : { model },
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
		GotCredentialIdentifierMessage: ({ index, message: inner }) =>
			model.sourceWrite === "Saving"
				? { model }
				: {
						model: {
							...model,
							credentialIdentifiers: Arr.map(model.credentialIdentifiers, (draft, at) =>
								at === index ? Field.update(draft, inner).model : draft,
							),
							// The refusal was about what was typed then.
							credentialError: inner._tag === "ChangedValue" ? null : model.credentialError,
						},
					},
		SubmittedCredential: () => {
			const secret = Str.trim(model.credentialDraft.value)
			const identifiers = Arr.map(model.credentialIdentifiers, (draft) => Str.trim(draft.value))
			if (
				secret === "" ||
				Arr.contains(identifiers, "") ||
				model.sourceWrite !== "Idle" ||
				model.addStep === "pick"
			) {
				return { model }
			}
			const source = credentialSourceOf(model.addStep)
			// The request refuses a longer one before it is sent, which would leave the save unanswered.
			const tooLong = Option.orElse(
				Option.map(
					Arr.findFirst(
						Arr.zip(source.identifiers ?? [], identifiers),
						([text, value]) => value.length > text.maxLength,
					),
					([text]) => text.tooLong,
				),
				() =>
					secret.length > source.field.maxLength
						? Option.some(source.field.tooLong)
						: Option.none(),
			)
			if (Option.isSome(tooLong)) return { model: { ...model, credentialError: tooLong.value } }
			return {
				model: { ...model, sourceWrite: "Saving", credentialError: null },
				commands: [source.save(secret, identifiers)],
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
						commands: [CREDENTIAL_SOURCES[model.removeProvider].delete()],
					},
		CompletedRemoveCredential: ({ provider, result }) => {
			const closed = liftRemoveDialog(
				Result.isSuccess(result)
					? withoutSourceOf({ ...model, sourceWrite: "Settling" }, provider)
					: { ...model, sourceWrite: "Idle" },
				Dialog.close(model.removeDialog),
			)
			return Result.match(result, {
				onFailure: (failure): Return => ({
					...closed,
					outMessage: toast("error", "Couldn't remove the source", failureMessage(failure)),
				}),
				onSuccess: (): Return =>
					withReread(
						{
							...closed,
							outMessage: toast("success", CREDENTIAL_SOURCES[provider].remove.toast),
						},
						context,
					),
			})
		},
		...chartEnvHandlers(model),
	})
