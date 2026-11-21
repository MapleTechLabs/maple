// Grafana `templating.list` to Maple dashboard variables. Pure.
import { type DashboardVariable, PromqlVariableLabel, PromqlVariableMatch } from "@maple/domain/http"
import { parse } from "@maple/promql"
import { replaceWith } from "@maple/strings"
import { Array as Arr, Order, Result, Schema, String as Str } from "effect"
import { asArray, asRecord, asString, type UnknownRecord } from "./dashboard-import-shared"

export interface GrafanaVariableConversion {
	readonly variables: ReadonlyArray<DashboardVariable>
	/** Grafana name to Maple name, for names `DashboardVariableName` refuses. */
	readonly renames: ReadonlyMap<string, string>
	/** `interval` variables: their references become `$__interval`. */
	readonly intervalNames: ReadonlySet<string>
	/** `datasource` variables: name to the plugin type they select. */
	readonly datasourceTypes: ReadonlyMap<string, string>
}

const VALID_NAME = /^[A-Za-z][A-Za-z0-9_]*$/u
const LABEL_VALUES = /^\s*label_values\(\s*(?:(.+?)\s*,\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*$/su

function mapleName(name: string, taken: Set<string>): string {
	const cleaned = Str.replace(/^[^A-Za-z]+/u, "")(Str.replace(/[^A-Za-z0-9_]/gu, "_")(name))
	const base = cleaned === "" ? "var" : cleaned
	let candidate = base
	let index = 2
	while (taken.has(candidate)) candidate = `${base}_${index++}`
	taken.add(candidate)
	return candidate
}

/** The selected value, unless it is Grafana's "All" sentinel. */
function currentValue(variable: UnknownRecord): string | undefined {
	const value = asRecord(variable.current)?.value
	const first = Arr.isArray(value) ? value[0] : value
	return typeof first === "string" && first !== "$__all" && first !== "" ? first : undefined
}

function queryText(variable: UnknownRecord): string | undefined {
	return (
		asString(variable.query) ?? asString(asRecord(variable.query)?.query) ?? asString(variable.definition)
	)
}

function customOptions(variable: UnknownRecord): Array<{ value: string; label?: string }> {
	const fromOptions = Arr.flatMap(asArray(variable.options), (option) => {
		const record = asRecord(option)
		const value = asString(record?.value)
		const text = asString(record?.text)
		if (value === undefined || value === "$__all") return []
		return [text !== undefined && text !== value ? { value, label: text } : { value }]
	})
	if (fromOptions.length > 0) return fromOptions
	// `a,b,c` or `label : value` pairs, as Grafana's custom variable editor writes them.
	return Arr.flatMap(Str.split(queryText(variable) ?? "", ","), (part) => {
		const [label, value] = Arr.map(Str.split(part, " : "), Str.trim)
		if (label === undefined || label === "") return []
		return value === undefined || value === "" ? [{ value: label }] : [{ value, label }]
	})
}

type QuerySource = Extract<DashboardVariable, { type: "query" }>["source"]

/** Datasource plugins that speak PromQL; Mimir, Cortex and Thanos use `prometheus` itself. */
export const PROMQL_DATASOURCE_TYPES: ReadonlySet<string> = new Set([
	"prometheus",
	"grafana-amazonprometheus-datasource",
	"grafana-azureprometheus-datasource",
	"victoriametrics-datasource",
	"victoriametrics-metrics-datasource",
])

const MATCHER =
	/\s*([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!~|!=|=)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)\s*(?:,|$)/gsu

/** A `$name`, `${name}` or `[[name]]` reference; a regex's `$` end anchor is not one. */
const VARIABLE_REF = /\$(?:\{|[A-Za-z_])|\[\[[A-Za-z_]/u

/**
 * A `label_values` selector as a `match[]` selector: label filters that name a dashboard variable
 * are dropped (variables do not narrow each other yet), the literal ones kept. `""` when nothing
 * literal is left, `undefined` when the selector cannot be read.
 */
function matchSelector(selector: string, name: string, warnings: string[]): string | undefined {
	const parts = /^\s*([A-Za-z_:][A-Za-z0-9_:]*)?\s*(?:\{(.*)\})?\s*$/su.exec(selector)
	if (parts === null) return undefined
	const [, metric = "", body = ""] = parts
	const matchers = Arr.map([...Str.matchAll(MATCHER)(body)], (m) => ({
		text: `${m[1]}${m[2]}${m[3]}`,
		value: m[3] ?? "",
	}))
	const parsed = Arr.join(
		Arr.map(matchers, (m) => m.text),
		"",
	)
	if (Str.replace(/[\s,]/gu, "")(body).length !== Str.replace(/[\s,]/gu, "")(parsed).length)
		return undefined
	const kept = Arr.filter(matchers, (m) => !VARIABLE_REF.test(m.value))
	if (kept.length < matchers.length) {
		warnings.push(
			`Variable "${name}" lists values without the filters in "${selector}" that use other variables; Maple variables do not narrow each other yet.`,
		)
	}
	const filters = Arr.join(
		Arr.map(kept, (m) => m.text),
		",",
	)
	return filters === "" ? metric : `${metric}{${filters}}`
}

/** A `label_values(...)` Prometheus query as a Maple variable source, when it can be one. */
function labelValuesSource(query: string, name: string, warnings: string[]): QuerySource | undefined {
	const match = LABEL_VALUES.exec(query)
	if (match === null) return undefined
	const [, selector, label = ""] = match
	if (!isPromqlLabel(label)) return undefined
	// `job` is the service name: OTel metrics carry it only as `service.name`, and the scraper sets
	// `service.name` to the job too, so the service list holds every job a dashboard can filter by.
	if (label === "job") {
		if (selector !== undefined && Str.trim(selector) !== "") {
			warnings.push(
				`Variable "${name}" lists every service; its selector "${selector}" was not imported, so it is not narrowed to that metric's jobs.`,
			)
		}
		return { kind: "facet", facet: "service" }
	}
	// Read by the discovery PromQL panels use, so Prometheus names and labels resolve as they do there.
	if (selector === undefined || Str.trim(selector) === "") return { kind: "promql", label }
	const selectorMatch = matchSelector(selector, name, warnings)
	if (selectorMatch === undefined) {
		warnings.push(
			`Variable "${name}" lists every ${label}; its selector "${selector}" could not be read.`,
		)
		return { kind: "promql", label }
	}
	// Every filter named a variable; matchSelector already said they were dropped.
	if (selectorMatch === "") return { kind: "promql", label }
	if (!isDiscoverySelector(selectorMatch)) {
		warnings.push(
			`Variable "${name}" lists every ${label}; Maple cannot narrow it by "${selectorMatch}", which is too long or matches every series.`,
		)
		return { kind: "promql", label }
	}
	return { kind: "promql", label, match: selectorMatch }
}

const isPromqlLabel = Schema.is(PromqlVariableLabel)
const isPromqlMatch = Schema.is(PromqlVariableMatch)

/** A selector discovery takes: within the stored limit, and one the parser accepts, which refuses all-empty matchers. */
const isDiscoverySelector = (selector: string): boolean => {
	if (!isPromqlMatch(selector)) return false
	const parsed = parse(selector)
	return Result.isSuccess(parsed) && parsed.success.type === "VectorSelector"
}

/** True for a PromQL datasource. */
export const speaksPromql = (type: string | undefined): type is string =>
	type !== undefined && PROMQL_DATASOURCE_TYPES.has(type)

/** What to say once a query on a PromQL datasource other than Prometheus itself is imported. */
export const promqlPluginNote = (type: string): string | undefined =>
	type === "prometheus"
		? undefined
		: `Queries on the ${type} datasource were imported as PromQL over Maple's metrics; check that they read the same series.`

/** Says a note once, when the query it describes was imported. */
export function noteOnce(note: string | undefined, warnings: string[]): void {
	if (note !== undefined && !Arr.contains(warnings, note)) warnings.push(note)
}

/** Grafana's variable `regex` and `sort` have no Maple equivalent; say so instead of dropping them. */
function unsupportedOptionWarnings(variable: UnknownRecord, name: string, warnings: string[]) {
	const regex = asString(variable.regex)
	if (regex !== undefined && Str.trim(regex) !== "") {
		warnings.push(
			`Variable "${name}" filters its values with the regex ${regex} in Grafana; Maple lists every value.`,
		)
	}
	// 0 is unsorted and 1 alphabetical, which is the order Maple lists values in.
	const sort = typeof variable.sort === "number" ? variable.sort : 0
	if (sort > 1) {
		warnings.push(
			`Variable "${name}" has a custom sort order in Grafana; Maple lists its values alphabetically.`,
		)
	}
}

/** The plugin type a datasource reference names: `{ type }`, or a `${NAME}` input or `$name` datasource variable. */
export function datasourceType(
	datasource: unknown,
	datasourceTypes: ReadonlyMap<string, string>,
): string | undefined {
	const record = asRecord(datasource)
	const type = asString(record?.type)
	if (type !== undefined && type !== "datasource") return type
	const ref = asString(record?.uid) ?? asString(datasource)
	const name = ref === undefined ? undefined : /^\$\{?([A-Za-z0-9_]+)\}?$/u.exec(ref)?.[1]
	return name === undefined ? undefined : datasourceTypes.get(name)
}

function convertOne(
	variable: UnknownRecord,
	name: string,
	datasourceTypes: ReadonlyMap<string, string>,
	warnings: string[],
): DashboardVariable | undefined {
	const type = asString(variable.type)
	const label = asString(variable.label)
	const current = currentValue(variable)
	const base = {
		name,
		...(label === undefined ? undefined : { label }),
		...(variable.includeAll === true ? { includeAll: true } : undefined),
	}
	const textbox = (value: string | undefined): DashboardVariable => ({
		...base,
		type: "textbox",
		...(value === undefined ? undefined : { defaultValue: value }),
	})
	switch (type) {
		case "custom":
			return {
				...base,
				type: "custom",
				options: customOptions(variable),
				...(current === undefined ? undefined : { defaultValue: current }),
			}
		case "constant":
			return textbox(queryText(variable) ?? current)
		case "textbox":
			return textbox(current ?? queryText(variable))
		case "query": {
			const query = queryText(variable) ?? ""
			const plugin = datasourceType(variable.datasource, datasourceTypes)
			const source =
				plugin === undefined || speaksPromql(plugin)
					? labelValuesSource(query, name, warnings)
					: undefined
			if (source !== undefined) {
				if (plugin !== undefined) noteOnce(promqlPluginNote(plugin), warnings)
				unsupportedOptionWarnings(variable, name, warnings)
				return {
					...base,
					type: "query",
					source,
					...(current === undefined ? undefined : { defaultValue: current }),
				}
			}
			warnings.push(
				`Variable "${name}" became a text box: Maple cannot run its ${plugin ?? "Prometheus"} query "${query}".`,
			)
			return textbox(current)
		}
		default:
			warnings.push(`Variable "${name}" of type "${type ?? "unknown"}" became a text box.`)
			return textbox(current)
	}
}

/** Every `templating.list` entry Maple can hold, plus how queries must be rewritten for it. */
export function convertGrafanaVariables(
	templating: unknown,
	inputTypes: ReadonlyMap<string, string>,
	warnings: string[],
): GrafanaVariableConversion {
	const list = Arr.flatMap(asArray(asRecord(templating)?.list), (item) => {
		const record = asRecord(item)
		const name = asString(record?.name)
		return record === null || name === undefined ? [] : [{ record, name }]
	})
	const datasourceTypes = new Map(inputTypes)
	const intervalNames = new Set<string>()
	for (const { record, name } of list) {
		const type = asString(record.type)
		if (type === "datasource") datasourceTypes.set(name, asString(record.query) ?? "")
		if (type === "interval") intervalNames.add(name)
	}

	const taken = new Set<string>()
	// Valid names are claimed first, so a sanitized name never takes one a later variable owns.
	const reserved = new Set(
		Arr.flatMap(list, ({ record, name }) => {
			const type = asString(record.type)
			const skipped = type === "datasource" || type === "interval" || type === "adhoc"
			return !skipped && VALID_NAME.test(name) ? [name] : []
		}),
	)
	const renames = new Map<string, string>()
	const variables: DashboardVariable[] = []
	for (const { record, name } of list) {
		const type = asString(record.type)
		if (type === "datasource") continue
		if (type === "interval") {
			warnings.push(
				`Interval variable "${name}" was not imported; its references now use $__interval in PromQL and $__interval_s (seconds) in ClickHouse SQL.`,
			)
			continue
		}
		if (type === "adhoc") {
			warnings.push(`Ad hoc filter variable "${name}" was not imported.`)
			continue
		}
		const maple =
			VALID_NAME.test(name) && !taken.has(name)
				? name
				: mapleName(name, new Set([...taken, ...reserved]))
		taken.add(maple)
		if (maple !== name) {
			renames.set(name, maple)
			warnings.push(`Variable "${name}" was renamed to "${maple}"; queries that use it were rewritten.`)
		}
		const converted = convertOne(record, maple, datasourceTypes, warnings)
		if (converted !== undefined) variables.push(converted)
	}
	return { variables, renames, intervalNames, datasourceTypes }
}

const escapeRegex = (value: string) => Str.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")(value)

/** Every reference to any of `names`, in all three syntaxes, longest name first. */
const referencesPattern = (names: ReadonlyArray<string>) => {
	const alt = Arr.join(
		Arr.map(
			Arr.sort(
				names,
				Order.mapInput(Order.Number, (n: string) => -n.length),
			),
			escapeRegex,
		),
		"|",
	)
	return new RegExp(`\\$\\{(${alt})(:[A-Za-z]+)?\\}|\\[\\[(${alt})\\]\\]|\\$(${alt})(?![A-Za-z0-9_])`, "gu")
}

const renamedReference = (match: string, to: string, format: string | undefined) => {
	if (Str.startsWith("[[")(match)) return `[[${to}]]`
	if (Str.startsWith("${")(match)) return `\${${to}${format ?? ""}}`
	return `$${to}`
}

/**
 * A query with renamed variables renamed and interval variables replaced by `interval`: `$__interval`
 * for PromQL, `$__interval_s` for ClickHouse SQL, the only interval macro raw SQL expands.
 */
export function rewriteVariableRefs(
	query: string,
	conversion: GrafanaVariableConversion,
	interval: "$__interval" | "$__interval_s",
): string {
	const names = [...conversion.intervalNames, ...conversion.renames.keys()]
	if (names.length === 0) return query
	// One pass over the original: a rename's output is never renamed again.
	return replaceWith(
		query,
		referencesPattern(names),
		(
			match: string,
			braced: string | undefined,
			format: string | undefined,
			bracketed: string | undefined,
			bare: string | undefined,
		) => {
			const name = braced ?? bracketed ?? bare ?? ""
			if (conversion.intervalNames.has(name)) return interval
			const to = conversion.renames.get(name)
			return to === undefined ? match : renamedReference(match, to, format)
		},
	)
}
