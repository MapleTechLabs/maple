import { Array as Arr, Deferred, Effect, Record as Rec, Schema } from "effect"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import { QueryEngineExecuteRequest } from "@maple/domain/query-engine"
import type { TenantContext } from "@maple/domain/http"
import {
	ALL_VALUE,
	collectExpandedVariableRefs,
	dashboardVariableOptionsFromResult,
	dashboardVariableOptionsQuery,
	resolveDashboardVariableValue,
	type ResolvedVariable,
	type VariableValues,
} from "@maple/query-engine"
import { type DashboardVariable, variablesForWidget } from "@maple/widgets/dashboard"
import { untrustedText } from "./format"

/** The variables one widget references, resolved the way the dashboard resolves them. */
export interface WidgetVariables {
	/** What the interpolator consumes. */
	readonly values: VariableValues
	/** Name to the value used, `$__all` for an All selection, so it can be passed back as `variables`. */
	readonly used: Readonly<Record<string, string>>
	readonly notes: ReadonlyArray<string>
	/** Referenced variables that came out empty: a chart filtered on them shows nothing. */
	readonly unresolved: ReadonlyArray<string>
}

export const NO_WIDGET_VARIABLES: WidgetVariables = { values: {}, used: {}, notes: [], unresolved: [] }

export interface VariableOptions {
	readonly options: ReadonlyArray<string>
	/** Listing failed, as opposed to listing nothing. */
	readonly failed: boolean
}

interface TimeWindow {
	readonly startTime: string
	readonly endTime: string
}

/** A `query` variable's options over a window; never fails, a failed listing is `failed: true`. */
export type VariableOptionsLister = (
	variable: DashboardVariable,
	timeRange: TimeWindow,
) => Effect.Effect<VariableOptions>

const NO_OPTIONS: VariableOptions = { options: [], failed: false }
const FAILED_OPTIONS: VariableOptions = { options: [], failed: true }

const encodeQueryKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/**
 * Lists `query` variable options through the query engine, once per (query, window): the
 * widgets of one board share a variable, so a mutation inspecting several of them lists it once.
 */
export const makeVariableOptionsLister = Effect.fn("McpWidgetVariables.makeOptionsLister")(function* (
	tenant: TenantContext,
) {
	const queryEngine = yield* QueryEngineService
	const listed = new Map<string, Deferred.Deferred<VariableOptions>>()

	const lister: VariableOptionsLister = (variable, timeRange) => {
		const query = dashboardVariableOptionsQuery(variable)
		if (query === null) return Effect.succeed(NO_OPTIONS)
		const key = `${encodeQueryKey(query)}|${timeRange.startTime}|${timeRange.endTime}`
		return Effect.suspend(() => {
			const pending = listed.get(key)
			if (pending !== undefined) return Deferred.await(pending)
			const deferred = Deferred.makeUnsafe<VariableOptions>()
			listed.set(key, deferred)
			return queryEngine
				.execute(
					tenant,
					new QueryEngineExecuteRequest({
						startTime: timeRange.startTime,
						endTime: timeRange.endTime,
						query,
					}),
				)
				.pipe(
					Effect.map((response): VariableOptions => ({
						options: dashboardVariableOptionsFromResult(query, response.result),
						failed: false,
					})),
					Effect.tapError((cause) =>
						Effect.logWarning("dashboard variable options failed", cause).pipe(
							Effect.annotateLogs({ "maple.variable.name": variable.name }),
						),
					),
					// A dropdown that cannot load never fails the inspection, as on a share.
					Effect.orElseSucceed(() => FAILED_OPTIONS),
					Effect.catchDefect(() => Effect.succeed(FAILED_OPTIONS)),
					Effect.tap((options) => Deferred.succeed(deferred, options)),
					// Interrupted first: release anyone waiting (a no-op once completed).
					Effect.ensuring(Deferred.succeed(deferred, FAILED_OPTIONS)),
				)
		})
	}
	return lister
})

type Source = "variables" | "default" | "all" | "first_option" | "empty"

const describeSource = {
	variables: "from `variables`",
	default: "default",
	all: "All",
	first_option: "first option",
	empty: "no value",
} as const satisfies Record<Source, string>

/** Where the ladder (selection, default, All, first option) landed for one variable. */
function sourceOf(variable: DashboardVariable, selected: string | undefined, value: string): Source {
	if (value === "") return "empty"
	if (selected === value) return "variables"
	if (value === ALL_VALUE) return "all"
	if (variable.defaultValue === value) return "default"
	return "first_option"
}

/**
 * Resolve the dashboard variables a widget's data source references, so its params are
 * interpolated before they run, exactly as the board does. Values in `overrides` play the role
 * of the picker selection. A `query` variable's options are listed when the ladder needs them:
 * no override or default to land on, or an All that expands into a value list.
 */
export const resolveWidgetVariables = Effect.fn("McpWidgetVariables.resolve")(function* (input: {
	readonly variables: ReadonlyArray<DashboardVariable>
	readonly widget: Parameters<typeof variablesForWidget>[1]
	readonly overrides: Readonly<Record<string, string>>
	readonly timeRange: TimeWindow
	readonly listOptions: VariableOptionsLister
}) {
	// The data source alone: a `$name` in the title does not filter anything.
	const { id, visualization, layout, dataSource } = input.widget
	const referenced = variablesForWidget(input.variables, { id, visualization, layout, dataSource })
	const ignored = Arr.filter(
		Rec.keys(input.overrides),
		(name) => !Arr.some(referenced, (variable) => variable.name === name),
	)
	const ignoredNotes = Arr.map(
		ignored,
		(name) => `$${name} is not used by this widget's queries; its value was ignored.`,
	)
	if (referenced.length === 0) return { ...NO_WIDGET_VARIABLES, notes: ignoredNotes }

	// All only needs the option list where it expands (SQL, route params); a where-clause drops it.
	const expanded = collectExpandedVariableRefs(dataSource)

	const resolved = yield* Effect.forEach(
		referenced,
		Effect.fnUntraced(function* (variable) {
			const selected = input.overrides[variable.name]
			// Without options yet, does the ladder still need them?
			const early = resolveDashboardVariableValue(variable, selected, { options: [], loading: true })
			const needsOptions =
				early === undefined || (early === ALL_VALUE && expanded.includes(variable.name))
			const listed: VariableOptions =
				variable.type === "custom"
					? { options: Arr.map(variable.options, (option) => option.value), failed: false }
					: variable.type === "query" && needsOptions
						? yield* input.listOptions(variable, input.timeRange)
						: NO_OPTIONS
			const value =
				resolveDashboardVariableValue(variable, selected, {
					options: listed.options,
					loading: false,
				}) ?? ""
			const entry: ResolvedVariable = {
				value,
				isAll: value === ALL_VALUE,
				options: [...listed.options],
			}
			return { variable, selected, entry, failed: listed.failed }
		}),
	)

	const described = Arr.map(resolved, ({ variable, selected, entry, failed }) => {
		const source = sourceOf(variable, selected, entry.value)
		const shown = entry.isAll ? "All" : entry.value
		const notes = [
			...(selected === ALL_VALUE && variable.includeAll !== true
				? [`$${variable.name} does not offer All on this dashboard, so its own fallback was used.`]
				: []),
			...(entry.isAll && failed
				? [
						`$${variable.name} is All but listing its options failed, so it expanded to no values; the board would not run this widget until they load.`,
					]
				: []),
			...(source === "empty"
				? [
						`$${variable.name} has no value here (${failed ? "listing its options failed" : "no default and no options in this window"}), so the widget ran with an empty one. Pass variables={"${variable.name}":"<value>"} to inspect it with a real value.`,
					]
				: []),
		]
		return {
			name: variable.name,
			shown,
			empty: source === "empty",
			// A first option is warehouse data, so it is quoted like any telemetry text.
			part: `$${variable.name} = ${untrustedText(shown, 120)} (${describeSource[source]})`,
			notes,
		}
	})

	return {
		values: Rec.fromEntries(Arr.map(resolved, ({ variable, entry }) => [variable.name, entry] as const)),
		used: Rec.fromEntries(
			Arr.map(resolved, ({ variable, entry }) => [variable.name, entry.value] as const),
		),
		notes: [
			`Dashboard variables: ${Arr.join(
				Arr.map(described, (d) => d.part),
				", ",
			)}.`,
			...Arr.flatMap(described, (d) => d.notes),
			...ignoredNotes,
		],
		unresolved: Arr.map(
			Arr.filter(described, (d) => d.empty),
			(d) => d.name,
		),
	} satisfies WidgetVariables
})
