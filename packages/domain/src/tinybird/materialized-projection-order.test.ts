import { describe, expect, it } from "vitest"
import { datasources, pipes } from "../generated/tinybird-project-manifest"
import { Array as Arr, Option, String as Str } from "effect"

interface Resource {
	readonly name: string
	readonly content: string
}

const blockBody = (resource: Resource, section: string): string => {
	const match = new RegExp(`${section} >\\n([\\s\\S]*?)(?:\\n\\n[A-Z_]+(?: |\\n|")|$)`).exec(
		resource.content,
	)
	expect(match, `${resource.name} should include ${section} block`).not.toBeNull()
	return Str.trim(Str.replace(/^    /gm, "")(match![1]))
}

const splitTopLevelCommas = (input: string): string[] => {
	const parts: string[] = []
	let start = 0
	let depth = 0
	let inString = false

	for (let index = 0; index < input.length; index++) {
		const char = input[index]
		const previous = input[index - 1]

		if (char === "'" && previous !== "\\") {
			inString = !inString
			continue
		}

		if (inString) continue
		if (char === "(") depth++
		if (char === ")") depth--

		if (char === "," && depth === 0) {
			parts.push(Str.trim(Str.slice(start, index)(input)))
			start = index + 1
		}
	}

	parts.push(Str.trim(Str.slice(start)(input)))
	return Arr.filter(parts, (part) => part.length > 0)
}

const datasourceColumns = (resource: Resource): string[] =>
	Arr.map(splitTopLevelCommas(blockBody(resource, "SCHEMA")), (column) => {
		const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+/.exec(column)
		expect(match, `could not parse datasource column from ${column}`).not.toBeNull()
		return match![1]
	})

const findTopLevelFrom = (sql: string): number => {
	let depth = 0
	let inString = false

	for (let index = 0; index < sql.length; index++) {
		const char = sql[index]
		const previous = sql[index - 1]

		if (char === "'" && previous !== "\\") {
			inString = !inString
			continue
		}

		if (inString) continue
		if (char === "(") depth++
		if (char === ")") depth--

		if (
			depth === 0 &&
			/^FROM\b/i.test(Str.slice(index)(sql)) &&
			(index === 0 || /\s/.test(sql[index - 1]))
		) {
			return index
		}
	}

	throw new Error(`could not find top-level FROM in SQL:\n${sql}`)
}

/**
 * Drop `--` line comments before scanning. Both scanners below track string
 * literals by toggling on `'`, and an apostrophe in prose ("Drizzle\'s params
 * line") reads as an opening quote — which silently desynchronizes the rest of
 * the parse and surfaces as "could not find top-level FROM".
 */
const stripLineComments = (sql: string): string =>
	Arr.join(
		Arr.map(Str.split("\n")(sql), (line) => Str.replace(/(^|\s)--.*$/, "")(line)),
		"\n",
	)

const pipeSelectColumns = (resource: Resource): string[] => {
	const sql = stripLineComments(blockBody(resource, "SQL"))
	const selectMatch = /\bSELECT\b/i.exec(sql)
	expect(selectMatch, `${resource.name} should include SELECT`).not.toBeNull()

	const selectStart = selectMatch!.index + selectMatch![0].length
	const selectList = Str.slice(selectStart, findTopLevelFrom(sql))(sql)

	return Arr.map(splitTopLevelCommas(selectList), (expression) => {
		const normalized = Str.trim(Str.replace(/\s+/g, " ")(expression))
		const alias = /\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)$/i.exec(normalized)
		if (alias) return alias[1]

		const bareColumn = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(normalized)
		expect(bareColumn, `SELECT expression needs an explicit alias: ${normalized}`).not.toBeNull()
		return bareColumn![1]
	})
}

describe("materialized projection order", () => {
	it("keeps materialized projections aligned with target datasource column order", () => {
		const targets = [
			["ai_trace_index", "ai_trace_index_mv"],
			["ai_crawler_requests", "ai_crawler_requests_mv"],
			["scanner_requests", "scanner_requests_mv"],
			["service_runtimes_hourly", "service_runtimes_hourly_mv"],
			["ci_runs", "ci_runs_mv"],
			["ci_jobs", "ci_jobs_mv"],
			["service_map_edges_hourly", "service_map_edges_hourly_ingest_mv"],
			["service_overview_spans", "service_overview_spans_mv"],
			["service_overview_hourly", "service_overview_hourly_mv"],
			["service_operations_hourly", "service_operations_hourly_mv"],
			["service_endpoint_details_hourly", "service_endpoint_details_hourly_mv"],
			["trace_list_mv", "trace_list_mv_mv"],
			["trace_facets_hourly", "trace_facets_hourly_mv"],
			["logs_aggregates_hourly", "logs_aggregates_hourly_mv"],
			["error_events_by_time", "error_events_by_time_mv"],
			["error_fingerprints_minutely", "error_fingerprints_minutely_mv"],
		] as const

		for (const [datasourceName, pipeName] of targets) {
			const datasource = Option.getOrUndefined(
				Arr.findFirst(datasources, (resource) => resource.name === datasourceName),
			)
			const pipe = Option.getOrUndefined(Arr.findFirst(pipes, (resource) => resource.name === pipeName))
			expect(datasource, `${datasourceName} datasource should exist`).toBeDefined()
			expect(pipe, `${pipeName} pipe should exist`).toBeDefined()

			expect(pipeSelectColumns(pipe!)).toEqual(datasourceColumns(datasource!))
		}
	})
})
