import type { McpToolRegistrar } from "./types"
import { McpInvalidInputError } from "./types"
import { CurrentMcpTenant } from "../tenant"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"
import { defaultStepSeconds, parseStepMs, toOutput } from "../lib/promql-result"
import { renderPromqlOutput } from "../lib/promql-render"
import * as P from "../lib/params"
import { Effect, Schema } from "effect"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { MAX_STEPS, PromqlQueryService } from "@maple/backend/services/promql/PromqlQueryService"

const WINDOW = P.timeWindow({ defaultHours: 1, maxHours: 7 * 24 })

const EXAMPLE = "sum by (job) (rate(http_server_request_duration_seconds_count[5m]))"

const DESCRIPTION = [
	"Run a PromQL query over the org's metrics, Prometheus-exact. Range evaluation over start_time..end_time by default; instant=true evaluates once at end_time.",
	"Metric names are the Prometheus names list_metrics returns in its PromQL column (histograms read as `_bucket` with `le`, `_count` and `_sum`); copy them rather than translating OTel names. Labels are attribute keys with underscores (`host.name` is `host_name`); `job` is the service name, prefixed by its `service.namespace` when it sets one (`shop/checkout`), and `instance` the service instance id. An unknown metric or label comes back as a warning naming the nearest ones.",
	`Examples: \`${EXAMPLE}\`; \`histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket[5m])))\`; \`sum by (job) (rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[5m])) / sum by (job) (rate(http_server_request_duration_seconds_count[5m]))\`.`,
	"Returns at most 20 series (highest peaks) and the last 200 points of each.",
].join(" ")

export function registerQueryPromqlTool(server: McpToolRegistrar) {
	server.define({
		name: "query_promql",
		title: "Query PromQL",
		description: DESCRIPTION,
		parameters: Schema.Struct({
			query: P.text(`PromQL expression, e.g. ${EXAMPLE}`),
			...WINDOW.fields,
			step: P.optionalText(
				"Range resolution as a Prometheus duration (`30s`, `1m`, `1h`) or seconds. Default: a round step giving about 60 to 120 points.",
			),
			instant: P.optionalFlag("Evaluate once at end_time instead of over the window (default false)"),
		}),
		hints: { readOnly: true },
		phrases: ["Running a PromQL query", "Querying metrics"],
		handler: Effect.fn("McpTool.queryPromql")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, "query_promql")
			const tenant = yield* CurrentMcpTenant
			const promql = yield* PromqlQueryService
			const instant = params.instant === true
			const endMs = parseWarehouseDateTime(et)
			const startMs = instant ? endMs : parseWarehouseDateTime(st)
			const requested = params.step === undefined ? undefined : parseStepMs(params.step)
			if (params.step !== undefined && requested === undefined) {
				return yield* new McpInvalidInputError({
					message: `step "${params.step}" is not a Prometheus duration or a number of seconds, in whole milliseconds.`,
					parameter: "step",
					example: "1m",
				})
			}
			const stepMs = instant ? 0 : (requested ?? defaultStepSeconds((endMs - startMs) / 1000) * 1000)
			const stepSeconds = stepMs / 1000
			// The engine's rule, as Prometheus': at most MAX_STEPS whole steps across the window.
			if (!instant && Math.floor((endMs - startMs) / stepMs) > MAX_STEPS) {
				return yield* new McpInvalidInputError({
					message: `step "${params.step ?? `${stepSeconds}s`}" gives more than ${MAX_STEPS} steps over this window; use at least ${Math.ceil((endMs - startMs) / 1000 / MAX_STEPS)}s.`,
					parameter: "step",
					example: `${defaultStepSeconds((endMs - startMs) / 1000)}s`,
				})
			}
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.ai.promql.instant": instant,
				"maple.ai.promql.step_seconds": stepSeconds,
			})

			const result = yield* promql.query(tenant, { query: params.query, startMs, endMs, stepMs }).pipe(
				Effect.catchTags({
					"@maple/backend/promql/PromqlBadQueryError": (error) =>
						Effect.fail(
							new McpInvalidInputError({
								message: `Invalid PromQL: ${error.message}${error.position === undefined ? "" : ` (at position ${error.position})`}`,
								parameter: "query",
								example: EXAMPLE,
							}),
						),
					"@maple/backend/promql/PromqlExecutionError": (error) =>
						Effect.fail(
							new McpInvalidInputError({
								message: `PromQL could not be evaluated: ${error.message}`,
								parameter: "query",
							}),
						),
					...warehouseReadToMcpHandlers("query_promql"),
				}),
			)
			const output = toOutput({
				query: params.query,
				instant,
				timeRange: { start: st, end: et },
				stepSeconds,
				result,
			})
			yield* Effect.annotateCurrentSpan("result.rowCount", output.totalSeries)
			return output
		}),
		render: renderPromqlOutput,
	})
}
