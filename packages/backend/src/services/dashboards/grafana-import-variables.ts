// Grafana `templating.list` to Maple dashboard variables. Pure.
import type { DashboardVariable } from "@maple/domain/http"
import { replaceWith } from "@maple/strings"
import { Array as Arr, String as Str } from "effect"
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
const METRIC_NAME = /^[A-Za-z_:][A-Za-z0-9_:]*$/u
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

/** Prometheus metric types Maple keeps in different tables; guessed from the name's suffix. */
function guessMetricType(metric: string): "sum" | "gauge" | "histogram" {
	if (/_(total|created)$/u.test(metric)) return "sum"
	if (/_(bucket|count|sum)$/u.test(metric)) return "histogram"
	return "gauge"
}

type QuerySource = Extract<DashboardVariable, { type: "query" }>["source"]

/** A `label_values(...)` Prometheus query as a Maple variable source, when it can be one. */
function labelValuesSource(query: string, name: string, warnings: string[]): QuerySource | undefined {
	const match = LABEL_VALUES.exec(query)
	if (match === null) return undefined
	const [, selector, label = ""] = match
	if (label === "job") return { kind: "facet", facet: "service" }
	if (selector === undefined) return undefined
	const [metricPart, matchers] = Str.split(selector, "{")
	const metric = Str.trim(metricPart)
	if (!METRIC_NAME.test(metric)) return undefined
	if (matchers !== undefined && !/^\s*\}/u.test(matchers)) {
		warnings.push(
			`Variable "${name}" lists every ${label} of ${metric}; the label filters in "${selector}" were not imported.`,
		)
	}
	return label === "instance"
		? {
				kind: "metric",
				metricType: guessMetricType(metric),
				metricNames: [metric],
				scope: "resource",
				attributeKey: "service.instance.id",
			}
		: {
				kind: "metric",
				metricType: guessMetricType(metric),
				metricNames: [metric],
				scope: "metric",
				attributeKey: label,
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
				plugin === undefined || plugin === "prometheus"
					? labelValuesSource(query, name, warnings)
					: undefined
			if (source !== undefined) {
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
	const renames = new Map<string, string>()
	const variables: DashboardVariable[] = []
	for (const { record, name } of list) {
		const type = asString(record.type)
		if (type === "datasource") continue
		if (type === "interval") {
			warnings.push(`Interval variable "${name}" was not imported; its references now use $__interval.`)
			continue
		}
		if (type === "adhoc") {
			warnings.push(`Ad hoc filter variable "${name}" was not imported.`)
			continue
		}
		const maple = VALID_NAME.test(name) && !taken.has(name) ? name : mapleName(name, taken)
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

const referencePattern = (name: string) => {
	const escaped = escapeRegex(name)
	return new RegExp(
		`\\$\\{${escaped}(:[A-Za-z]+)?\\}|\\[\\[${escaped}\\]\\]|\\$${escaped}(?![A-Za-z0-9_])`,
		"gu",
	)
}

const renamedReference = (match: string, to: string, format: string | undefined) => {
	if (Str.startsWith("[[")(match)) return `[[${to}]]`
	if (Str.startsWith("${")(match)) return `\${${to}${format ?? ""}}`
	return `$${to}`
}

/** A query with renamed variables renamed and interval variables replaced by `$__interval`. */
export function rewriteVariableRefs(query: string, conversion: GrafanaVariableConversion): string {
	let out = query
	for (const name of conversion.intervalNames) {
		out = Str.replace(referencePattern(name), "$$__interval")(out)
	}
	for (const [from, to] of conversion.renames) {
		out = replaceWith(out, referencePattern(from), (match: string, format: string | undefined) =>
			renamedReference(match, to, format),
		)
	}
	return out
}
