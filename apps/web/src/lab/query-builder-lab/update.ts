import type { OrgId } from "@maple/domain"
import { Option } from "effect"
import { Command, type Update } from "foldkit"
import * as Keyed from "../../data/keyed"
import { requestKey } from "../../data/request-key"
import { resolveWindow } from "../../data/time-range"
import type { Resources } from "../../platform/resources"
import { AUTOCOMPLETE_LOOKUPS } from "../../page/kit/autocomplete-lookups"
import { applyQueryChange } from "../../page/kit/query-builder/change"
import * as TimeRangePicker from "../../page/kit/time-range-picker"
import {
	CheckSession,
	CompleteReloadSpin,
	CreateCloneId,
	CreateFormula,
	CreateQuery,
	FetchAutocomplete,
	FetchMetrics,
	FetchTimeseries,
	ResolveWindow,
	StampRun,
} from "./command"
import { metricOptionsOf, relabelFormulas, relabelQueries, withFirstMetric } from "./derive"
import { type Flags, Message, type Model, type SubmittedInput, type TimeSearch } from "./model"
import { groupByStep, selectStep, updateQuery } from "./update-controls"

export type Return = Update.Return<Model, Message, Resources>
type Cmd = Command.Command<Message, never, Resources>

/** `search.timePreset ?? "1h"`: the route's default window. */
export const DEFAULT_PRESET = "1h"
const presetOf = (search: TimeSearch): string => search.timePreset ?? DEFAULT_PRESET

export const NO_ENABLED_QUERIES = "No enabled queries to run"

export const init = (flags: Flags): Return => ({
	model: {
		session: "Checking",
		orgId: null,
		timeZone: flags.timeZone,
		search: flags.search,
		window: resolveWindow(
			{ ...flags.search, preset: presetOf(flags.search), timeZone: flags.timeZone, snap: true },
			flags.nowMs,
		),
		picker: TimeRangePicker.init("query-builder-lab-time-range"),
		refreshVersion: 0,
		isReloading: false,
		queries: flags.queries,
		formulas: flags.formulas,
		lastRunAt: null,
		submitted: null,
		noQueriesError: null,
		results: Keyed.idle(),
		metrics: Keyed.idle(),
		autocomplete: {},
		selects: {},
		groupBys: {},
		scroll: null,
	},
	commands: [CheckSession()],
})

const withCommands = (step: Return, commands: ReadonlyArray<Cmd>): Return => ({
	model: step.model,
	commands: [...(step.commands ?? []), ...commands],
})

/** `AutocompleteValuesProvider` (not lazy): every lookup over the current window. */
const requestLookups = (model: Model, orgId: OrgId): Return =>
	AUTOCOMPLETE_LOOKUPS.reduce<Return>(
		(step, lookup) => {
			const key = requestKey(orgId, `autocomplete.${lookup}`, step.model.window)
			const slot = step.model.autocomplete[lookup] ?? Keyed.idle()
			return Option.match(Keyed.request(slot, key, "Load"), {
				onNone: () => step,
				onSome: (next) =>
					withCommands(
						{
							model: {
								...step.model,
								autocomplete: { ...step.model.autocomplete, [lookup]: next },
							},
							commands: step.commands,
						},
						[FetchAutocomplete({ key, lookup, window: step.model.window })],
					),
			})
		},
		{ model, commands: [] },
	)

const requestMetrics = (model: Model, orgId: OrgId, mode: Keyed.RequestMode): Return => {
	const key = requestKey(orgId, "listMetrics", { data: { limit: 300 } })
	return Option.match(Keyed.request(model.metrics, key, mode), {
		onNone: () => ({ model }),
		onSome: (metrics) => ({ model: { ...model, metrics }, commands: [FetchMetrics({ key })] }),
	})
}

const requestResults = (model: Model, input: SubmittedInput, mode: Keyed.RequestMode): Return => {
	if (model.orgId === null) return { model }
	const key = requestKey(model.orgId, "getQueryBuilderTimeseries", { data: input })
	return Option.match(Keyed.request(model.results, key, mode), {
		onNone: () => ({ model }),
		onSome: (results) => ({ model: { ...model, results }, commands: [FetchTimeseries({ key, input })] }),
	})
}

/** `navigate({ search: applyTimeRangeSearch(...) })`, kept local: the window re-resolves, snapped. */
const withSearch = (model: Model, search: TimeSearch): Return => ({
	model: { ...model, search },
	commands: [ResolveWindow({ search, preset: presetOf(search), timeZone: model.timeZone, mode: "Load" })],
})

const liftPicker = (model: Model, message: TimeRangePicker.Message): Return => {
	const next = TimeRangePicker.update(model.picker, message)
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotPickerMessage({ message: inner }),
	)
	const lifted = { ...model, picker: next.model }
	return next.outMessage === undefined || next.outMessage._tag === "RejectedRange"
		? { model: lifted, commands }
		: withCommands(withSearch(lifted, TimeRangePicker.searchPatchOf(next.outMessage)), commands)
}

/** Reload: the window unsnapped, and every `useRefreshableAtomValue` read refreshed. */
const reloaded = (model: Model): Return => {
	const bumped = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
	const resolve = ResolveWindow({
		search: model.search,
		preset: presetOf(model.search),
		timeZone: model.timeZone,
		mode: "Refresh",
	})
	const own = [resolve, CompleteReloadSpin({ version: bumped.refreshVersion })]
	if (bumped.orgId === null) return { model: bumped, commands: own }
	const metrics = requestMetrics(bumped, bumped.orgId, "Refresh")
	const results: Return =
		bumped.submitted === null
			? { model: metrics.model }
			: requestResults(metrics.model, bumped.submitted, "Refresh")
	return {
		model: results.model,
		commands: [...own, ...(metrics.commands ?? []), ...(results.commands ?? [])],
	}
}

/** `runQueries`: the drafts and window as they are now, or the no-enabled-queries error. */
const ran = (model: Model): Return => {
	if (!model.queries.some((query) => query.enabled))
		return { model: { ...model, noQueriesError: NO_ENABLED_QUERIES, submitted: null } }
	const submitted: SubmittedInput = {
		startTime: model.window.startTime,
		endTime: model.window.endTime,
		queries: model.queries,
		formulas: model.formulas,
	}
	return withCommands(requestResults({ ...model, noQueriesError: null, submitted }, submitted, "Load"), [
		StampRun(),
	])
}

const cloned = (model: Model, queryId: string, id: string): Return => {
	const source = model.queries.find((query) => query.id === queryId)
	return source === undefined
		? { model }
		: { model: { ...model, queries: relabelQueries([...model.queries, { ...source, id }]) } }
}

const signedIn = (model: Model, orgId: OrgId): Return => {
	const next: Model = { ...model, session: "SignedIn", orgId }
	const lookups = requestLookups(next, orgId)
	const metrics = requestMetrics(lookups.model, orgId, "Load")
	return { model: metrics.model, commands: [...(lookups.commands ?? []), ...(metrics.commands ?? [])] }
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		SucceededCheckSession: ({ orgId }) => signedIn(model, orgId),
		FailedCheckSession: ({ session }) => ({ model: { ...model, session } }),
		CompletedResolveWindow: ({ window }) => {
			const next = { ...model, window }
			return next.orgId === null ? { model: next } : requestLookups(next, next.orgId)
		},
		CompletedFetchAutocomplete: ({ key, lookup, result }) => ({
			model: {
				...model,
				autocomplete: {
					...model.autocomplete,
					[lookup]: Keyed.accept(model.autocomplete[lookup] ?? Keyed.idle(), key, result),
				},
			},
		}),
		CompletedFetchMetrics: ({ key, result }) => {
			const metrics = Keyed.accept(model.metrics, key, result)
			if (metrics === model.metrics || result._tag === "Failure")
				return { model: { ...model, metrics } }
			return {
				model: {
					...model,
					metrics,
					queries: withFirstMetric(model.queries, metricOptionsOf(result.success)),
				},
			}
		},
		CompletedFetchTimeseries: ({ key, result }) => ({
			model: { ...model, results: Keyed.accept(model.results, key, result) },
		}),
		GotPickerMessage: ({ message: inner }) => liftPicker(model, inner),
		ClickedResetTimeRange: () => withSearch(model, {}),
		ClickedReload: () => reloaded(model),
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		ClickedAddQuery: () => ({ model, commands: [CreateQuery({ index: model.queries.length })] }),
		CreatedQuery: ({ query }) => ({ model: { ...model, queries: [...model.queries, query] } }),
		ClickedAddFormula: () => ({
			model,
			commands: [
				CreateFormula({
					index: model.formulas.length,
					queryNames: model.queries.map((query) => query.name),
				}),
			],
		}),
		CreatedFormula: ({ formula }) => ({ model: { ...model, formulas: [...model.formulas, formula] } }),
		ClickedCloneQuery: ({ queryId }) => ({ model, commands: [CreateCloneId({ queryId })] }),
		CreatedCloneId: ({ queryId, id }) => cloned(model, queryId, id),
		ClickedRemoveQuery: ({ queryId }) => removedQuery(model, queryId),
		ClickedRemoveFormula: ({ formulaId }) => ({
			model: {
				...model,
				formulas: relabelFormulas(model.formulas.filter((formula) => formula.id !== formulaId)),
			},
		}),
		ClickedRun: () => ran(model),
		StampedRun: ({ at }) => ({ model: { ...model, lastRunAt: at } }),
		ToggledEnabled: ({ queryId }) => ({
			model: updateQuery(model, queryId, (query) => ({ ...query, enabled: !query.enabled })),
		}),
		ChangedQuery: ({ queryId, change }) => ({
			model: updateQuery(model, queryId, (query) => applyQueryChange(query, change)),
		}),
		GotSelectMessage: ({ id, message: inner }) => selectStep(model, id, inner),
		GotGroupByMessage: ({ queryId, message: inner }) => groupByStep(model, queryId, inner),
		ChangedFormulaText: ({ formulaId, field, value }) => ({
			model: {
				...model,
				formulas: model.formulas.map((formula) =>
					formula.id === formulaId ? { ...formula, [field]: value } : formula,
				),
			},
		}),
		// The editor's Enter only applies an open suggestion; the textarea stays single-purpose.
		PressedWhereEnter: () => ({ model }),
		MeasuredScroll: ({ metrics }) => ({ model: { ...model, scroll: metrics } }),
	})

const removedQuery = (model: Model, queryId: string): Return =>
	model.queries.length === 1
		? { model }
		: {
				model: {
					...model,
					queries: relabelQueries(model.queries.filter((query) => query.id !== queryId)),
				},
			}
