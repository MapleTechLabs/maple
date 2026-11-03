import { FUNNEL_MAX_STEPS, FUNNEL_POPULATION_FILTER_FIELDS } from "@maple/query-model"
import { Option, Result, Schema, Struct } from "effect"
import { Command } from "foldkit"
import * as Chart from "@maple/views/charts/chart"
import * as Keyed from "@maple/views/data/keyed"
import { type LoadFailure, toLoadFailure } from "@maple/views/data/load-failure"
import * as FilterSections from "@maple/views/ui/filters/filter-sections"
import * as Select from "@maple/views/ui/select"
import { toggleFilterValue } from "../../components/analytics/filters"
import type { Resources } from "../../platform/resources"
import { AppRoute, hrefOf } from "../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import { Breakdowns } from "../kit/analytics-filter-rail"
import {
	applyAnchorEdit,
	applyStepEdit,
	type StepEdit,
	type StepScope,
	stepComboUpdate,
	stepEditOf,
} from "../kit/funnel-steps"
import { routeWindowStep, snapModeOf } from "../kit/route-window"
import type { PresetValue } from "../kit/time-controls"
import * as TimeRangePicker from "../kit/time-range-picker"
import { CompleteReloadSpin, ResolveWindow, WaitForTypingPause } from "./command"
import { anchorNameOf, pathsOf, type Search, toAnchor, toFunnelStep } from "./definition"
import { FilterKey, Message, type RequestMode, SlotName } from "./message"
import { EventRow, FunnelRow, type Model, PathsRow } from "./model"
import { requestSlots } from "./requests"

type Return = PageReturn<Model, Message>
type Cmd = Command.Command<Message, never, Resources>

export const DEFAULT_PRESET: PresetValue = "1w"

const SLOT_SCHEMAS = {
	breakdowns: Breakdowns,
	events: Schema.Array(EventRow),
	previousEvents: Schema.Array(EventRow),
	funnel: Schema.Array(FunnelRow),
	paths: Schema.Array(PathsRow),
} satisfies Record<SlotName, Schema.Top>

const decodeFailure: LoadFailure = toLoadFailure("Couldn't read the response")

/** Folds an answer into every slot that asked under its key, decoded with that slot's schema. */
const settleSlots = (model: Model, key: string, result: Result.Result<unknown, LoadFailure>): Model =>
	SlotName.literals.reduce<Model>((next, name) => {
		if (next[name].key !== key) return next
		const decoded = Result.match(result, {
			onFailure: (failure) => Result.fail(failure),
			onSuccess: (value) =>
				Option.match(Schema.decodeUnknownOption(SLOT_SCHEMAS[name])(value), {
					onNone: () => Result.fail(decodeFailure),
					onSome: (data) => Result.succeed(data),
				}),
		})
		const slot: Keyed.Keyed<unknown, LoadFailure> = next[name]
		return { ...next, [name]: Keyed.accept(slot, key, decoded) }
	}, model)

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode): Cmd =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const searchHref = (search: Search) => hrefOf(AppRoute.ProductAnalytics({ search }))

/**
 * Goes to `search`. A new definition (a row's Funnel) replaces the drafts; the drafts' own (a blank
 * Page anchor the URL leaves out) keeps them. Either way a pending typing pause is cancelled.
 */
const navigate = (model: Model, search: Search, isReplace = false): Return => {
	const committed = committedOf(search)
	const drafts = committed === committedOf(withDrafts(model)) ? { committed } : draftsOf(search)
	return {
		model: { ...model, ...drafts, typingVersion: model.typingVersion + 1 },
		outMessage: PageOutMessage.RequestedNavigation({ url: searchHref(search), isReplace }),
	}
}

const withRequests = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return =>
	model.window === null ? { model } : requestSlots(model, context, model.window, mode)

// The step drafts. The URL holds the definition that runs; the drafts hold what is being edited.

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** The steps and anchor a search carries, as one comparable string. */
const committedOf = (search: Search): string =>
	encodeJson({ steps: search.steps ?? [], anchor: search.anchor ?? null })

const draftsOf = (search: Search): Pick<Model, "steps" | "anchor" | "committed"> => ({
	steps: search.steps ?? [],
	anchor: pathsOf(search).anchor,
	committed: committedOf(search),
})

/** The search with the drafts written in, so a tab or filter change carries what is being typed. */
export const withDrafts = (model: Model): Search => {
	const steps = model.steps.map(toFunnelStep)
	const anchor = toAnchor(model.anchor)
	return {
		...model.search,
		steps: steps.length === 0 ? undefined : steps,
		anchor: anchorNameOf(anchor) === "" ? undefined : anchor,
	}
}

/** The drafts written to the URL (replacing the entry: each edit is not a Back step). */
const commit = (model: Model): Return => navigate(model, withDrafts(model), true)

const applyEdit = (model: Model, scope: StepScope, edit: StepEdit): Model =>
	scope === "funnel"
		? { ...model, steps: applyStepEdit(model.steps, edit, FUNNEL_MAX_STEPS) }
		: { ...model, anchor: applyAnchorEdit(model.anchor, edit) }

/** A typed value waits for a pause before it runs; anything picked runs now. */
const edited = (model: Model, scope: StepScope, edit: StepEdit, isTyping: boolean): Return => {
	const next = applyEdit(model, scope, edit)
	if (!isTyping) return commit(next)
	const typingVersion = next.typingVersion + 1
	return { model: { ...next, typingVersion }, commands: [WaitForTypingPause({ version: typingVersion })] }
}

const lift = <A>(
	model: Model,
	commands: ReadonlyArray<Command.Command<A, never, Resources>> | undefined,
	wrap: (inner: A) => Message,
	patch: Partial<Model>,
): Return => ({ model: { ...model, ...patch }, commands: Command.mapMessages(commands ?? [], wrap) })

/** `onClearFilters`: the window, the tab and the definitions stay; the filters go. */
const clearedFilters = (search: Search): Search => Struct.omit(search, FUNNEL_POPULATION_FILTER_FIELDS)

/** The rail speaks every analytics filter; this page keeps the population ones. */
const decodeFilterKey = Schema.decodeUnknownOption(FilterKey)

const withFilter = (search: Search, key: FilterKey, value: string | undefined): Search => ({
	...search,
	[key]: value === "" ? undefined : value,
})

// ENTRY POINTS

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		window: null,
		breakdowns: Keyed.idle(),
		events: Keyed.idle(),
		previousEvents: Keyed.idle(),
		funnel: Keyed.idle(),
		paths: Keyed.idle(),
		...draftsOf(route.search),
		typingVersion: 0,
		stepCombos: {},
		selects: {},
		eventsQuery: "",
		eventsKind: "all",
		failedFavicons: [],
		filterSections: FilterSections.init(),
		timePicker: TimeRangePicker.init("product-analytics-time-range"),
		chart: Chart.init(),
		refreshVersion: 0,
		isReloading: false,
	}
	return {
		model,
		commands: [
			resolveCommand(model, context, "Load"),
			Command.mapMessage(FilterSections.ReadRemembered(), (message) =>
				Message.GotFilterSectionsMessage({ message }),
			),
		],
	}
}

export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return => {
	if (searchHref(model.search) === searchHref(route.search)) return { model }
	// A definition this page did not write (Back, a row's Funnel button) replaces the drafts.
	const drafts =
		committedOf(route.search) === model.committed
			? {}
			: { ...draftsOf(route.search), typingVersion: model.typingVersion + 1 }
	const next: Model = { ...model, ...drafts, search: route.search }
	return routeWindowStep(model.search, route.search, {
		resolve: (): Return => ({
			model: next,
			commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))],
		}),
		requestAll: (mode) => withRequests(next, context, mode),
	})
}

export const contextChanged = (model: Model, context: PageContext): Return =>
	withRequests(model, context, "Load")

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, mode }) => withRequests({ ...model, window }, context, mode),
		CompletedFetch: ({ key, result }) => ({ model: settleSlots(model, key, result) }),
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
		ClickedResetTimeRange: () =>
			navigate(model, {
				...withDrafts(model),
				startTime: undefined,
				endTime: undefined,
				timePreset: DEFAULT_PRESET,
			}),
		ClickedRetry: ({ slot }) =>
			model.window === null ? { model } : requestSlots(model, context, model.window, "Refresh", [slot]),
		ToggledFilter: ({ key: raw, value }) =>
			Option.match(decodeFilterKey(raw), {
				onNone: () => ({ model }),
				onSome: (key) => {
					const current = model.search[key]
					return navigate(
						model,
						withFilter(withDrafts(model), key, toggleFilterValue(current, value)),
					)
				},
			}),
		ChangedFilter: ({ key: raw, value }) =>
			Option.match(decodeFilterKey(raw), {
				onNone: () => ({ model }),
				onSome: (key) => navigate(model, withFilter(withDrafts(model), key, value)),
			}),
		ClickedClearFilters: () => navigate(model, clearedFilters(withDrafts(model))),
		FailedFavicon: ({ host }) =>
			model.failedFavicons.includes(host)
				? { model }
				: { model: { ...model, failedFavicons: [...model.failedFavicons, host] } },
		ChangedEventsQuery: ({ value }) => ({ model: { ...model, eventsQuery: value } }),
		PickedEventsKind: ({ kind }) => ({ model: { ...model, eventsKind: kind } }),
		ClickedClearEventsFilters: () => ({ model: { ...model, eventsQuery: "", eventsKind: "all" } }),
		ClickedStartFunnel: ({ step }) =>
			navigate(model, { ...withDrafts(model), tab: "funnels", steps: [step] }),
		ClickedStartPaths: ({ anchor }) => navigate(model, { ...withDrafts(model), tab: "paths", anchor }),
		ClickedSuggestedFunnel: ({ steps }) =>
			navigate(model, { ...withDrafts(model), tab: "funnels", steps }),
		ChangedStep: ({ scope, edit }) => edited(model, scope, edit, edit._tag === "ChangedText"),
		GotStepComboMessage: ({ id, message: inner }) => {
			const next = stepComboUpdate(model.stepCombos, id, inner, (m) =>
				Message.GotStepComboMessage({ id, message: m }),
			)
			const lifted: Model = { ...model, stepCombos: next.combos }
			if (Option.isNone(next.edit)) return { model: lifted, commands: next.commands }
			const step = edited(lifted, next.edit.value.scope, next.edit.value.edit, next.isTyping)
			return { ...step, commands: [...next.commands, ...(step.commands ?? [])] }
		},
		GotSelectMessage: ({ id, message: inner }) => {
			const next = Select.update(
				model.selects[id] ?? Select.init(id, { value: "", selectedIndex: null }),
				inner,
			)
			const lifted = lift(model, next.commands, (m) => Message.GotSelectMessage({ id, message: m }), {
				selects: { ...model.selects, [id]: next.model },
			})
			const target =
				next.outMessage === undefined ? Option.none() : stepEditOf(id, next.outMessage.value)
			if (Option.isNone(target)) return lifted
			const step = edited(lifted.model, target.value.scope, target.value.edit, false)
			return { ...step, commands: [...(lifted.commands ?? []), ...(step.commands ?? [])] }
		},
		PausedTyping: ({ version }) => (version === model.typingVersion ? commit(model) : { model }),
		PickedKeyBy: ({ keyBy }) => navigate(model, { ...withDrafts(model), keyBy }, true),
		PickedWindow: ({ seconds }) => navigate(model, { ...withDrafts(model), within: seconds }, true),
		PickedVariant: ({ variant }) => navigate(model, { ...withDrafts(model), view: variant }, true),
		PickedDirection: ({ direction }) => navigate(model, { ...withDrafts(model), direction }, true),
		PickedDepth: ({ depth }) => navigate(model, { ...withDrafts(model), depth }, true),
		PickedBranches: ({ branches }) => navigate(model, { ...withDrafts(model), branches }, true),
		GotFilterSectionsMessage: ({ message: inner }) => {
			const next = FilterSections.update(model.filterSections, inner)
			return lift(model, next.commands, (m) => Message.GotFilterSectionsMessage({ message: m }), {
				filterSections: next.model,
			})
		},
		GotTimePickerMessage: ({ message: inner }) => {
			const next = TimeRangePicker.update(model.timePicker, inner)
			const lifted = lift(model, next.commands, (m) => Message.GotTimePickerMessage({ message: m }), {
				timePicker: next.model,
			})
			if (next.outMessage === undefined || next.outMessage._tag === "RejectedRange") return lifted
			return {
				...navigate(lifted.model, {
					...withDrafts(lifted.model),
					...TimeRangePicker.searchPatchOf(next.outMessage),
				}),
				commands: lifted.commands,
			}
		},
		GotChartMessage: ({ message: inner }) => {
			const next = Chart.update(model.chart, inner)
			return lift(model, next.commands, (m) => Message.GotChartMessage({ message: m }), {
				chart: next.model,
			})
		},
	})
