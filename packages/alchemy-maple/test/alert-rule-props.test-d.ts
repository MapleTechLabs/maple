/**
 * The `AlertRule` constructor must refuse the field combinations the API
 * rejects (`AlertsService.normalizeRule`) and accept every valid shape,
 * Alchemy inputs included. A stale `@ts-expect-error` fails typechecking.
 */
import { Config, Effect } from "effect"
import type { Output } from "alchemy/Output"
import { AlertRule } from "../src/AlertRule"

const base = {
	name: "r",
	severity: "critical" as const,
	threshold: 0.05,
	window_minutes: 30,
	destination_ids: ["dest_1"],
}
const errorRate = { ...base, signal_type: "error_rate" as const, comparator: "gt" as const }
const raw = {
	...base,
	signal_type: "raw_query" as const,
	comparator: "gt" as const,
	raw_query_sql: "SELECT 1",
}
const builder = {
	...base,
	signal_type: "builder_query" as const,
	comparator: "gt" as const,
	query_builder_draft: { dataSource: "traces" },
}

export const acceptsOutputs = (services: Output<string[]>, destination: Output<string>) =>
	AlertRule("outputs", {
		...errorRate,
		name: Config.String("RULE_NAME"),
		service_names: services,
		destination_ids: [destination],
	})

// Every scope, comparison and signal is constructible with its own fields.
export const accepts = Effect.gen(function* () {
	// Named services, or every service grouped so each gets its own incident.
	yield* AlertRule("named", { ...errorRate, service_names: ["task-cache"] })
	yield* AlertRule("grouped", { ...errorRate, group_by: ["service.name"] })
	yield* AlertRule("grouped-minus", {
		...errorRate,
		group_by: ["service.name"],
		exclude_service_names: ["noisy"],
	})
	// Every service, ungrouped; `null` and `[]` clear what an earlier deploy set.
	yield* AlertRule("org", { ...errorRate, group_by: null, service_names: [] })
	yield* AlertRule("none", { ...errorRate, group_by: ["none"], alert_on_no_data: true })
	yield* AlertRule("empty", { ...errorRate, group_by: [], alert_on_no_data: true })
	yield* AlertRule("range", {
		...base,
		signal_type: "p95_latency",
		comparator: "between",
		threshold: 200,
		threshold_upper: 800,
	})
	yield* AlertRule("raw", { ...raw, raw_query_reducer: "max" })
	yield* AlertRule("builder", { ...builder, group_by: ["service.name"] })
	yield* AlertRule("builder-no-data", { ...builder, alert_on_no_data: true })
})

// …and only with its own fields.
export const rejects = Effect.gen(function* () {
	// @ts-expect-error #1898's example: group_by alongside service_names
	yield* AlertRule("a", { ...errorRate, service_names: ["task-cache"], group_by: ["service.name"] })
	// @ts-expect-error exclude_service_names alongside service_names
	yield* AlertRule("b", { ...errorRate, service_names: ["a"], exclude_service_names: ["b"] })
	// @ts-expect-error exclude_service_names needs group_by ["service.name"], exactly
	yield* AlertRule("c", { ...errorRate, group_by: ["http.route"], exclude_service_names: ["b"] })
	// @ts-expect-error builder_query needs its draft
	yield* AlertRule("d", { ...base, signal_type: "builder_query", comparator: "gt" })
	// @ts-expect-error a builder_query draft carries its own scope
	yield* AlertRule("e", { ...builder, service_names: ["a"] })
	// @ts-expect-error raw_query needs its SQL
	yield* AlertRule("f", { ...base, signal_type: "raw_query", comparator: "gt" })
	// @ts-expect-error raw_query reads no named services
	yield* AlertRule("g", { ...raw, service_names: ["a"] })
	// @ts-expect-error raw_query groups by nothing; its SQL returns the groups
	yield* AlertRule("h", { ...raw, group_by: ["service.name"] })
	// @ts-expect-error raw SQL belongs to raw_query
	yield* AlertRule("i", { ...errorRate, raw_query_sql: "SELECT 1" })
	// @ts-expect-error the reducer belongs to raw_query
	yield* AlertRule("j", { ...errorRate, raw_query_reducer: "max" })
	// @ts-expect-error between needs threshold_upper
	yield* AlertRule("k", { ...errorRate, comparator: "between" })
	// @ts-expect-error threshold_upper belongs to between and not_between
	yield* AlertRule("l", { ...errorRate, threshold_upper: 1 })
	// @ts-expect-error a grouped rule cannot alert on no data
	yield* AlertRule("m", { ...errorRate, group_by: ["service.name"], alert_on_no_data: true })
	// @ts-expect-error nor can a grouped builder_query
	yield* AlertRule("n", { ...builder, group_by: ["service.name"], alert_on_no_data: true })
})
