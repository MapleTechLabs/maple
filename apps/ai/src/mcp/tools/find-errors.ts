import { Effect, Schema } from "effect"
import { FindErrorsOutput } from "@maple/domain/mcp-outputs"
import { findErrors } from "@maple/query-engine/observability"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"
import type { McpToolRegistrar } from "./types"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { formatNumber, truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const WINDOW = P.timeWindow({ defaultHours: 6 })

export function registerFindErrorsTool(server: McpToolRegistrar) {
	server.define({
		name: "find_errors",
		// Do not reinstate the old claim that a fingerprint is the "same identity as
		// list_error_issues" — it is not. A fingerprint is a decimal UInt64 hash; an
		// issue id is a UUID. Conflating them was the sole cause of every production
		// error_detail failure.
		description:
			"Find and categorize errors by type with counts and affected services. Each error has a stable `fingerprint` (a decimal UInt64): pass it to error_detail for sample traces. The error-issue tools take an `issue_id` UUID from list_error_issues instead, which is a separate identity.",
		parameters: Schema.Struct({
			...WINDOW.fields,
			service: P.service(),
			environment: P.environment(),
			identity: P.optionalOneOf(
				["unexpected"],
				'Pass "unexpected" to keep only identities that break a no-unknown-errors policy: labels outside `namespace_prefix` (library tags such as `AI.Error`, bare `Error`) plus the 5xx and unexpected-error-envelope markers. Omit for all errors.',
			),
			namespace_prefix: P.optionalText(
				'The prefix every deliberate, namespaced error tag starts with (default "@maple/"). Only used with identity="unexpected".',
			),
			limit: P.limit({ default: 20, max: 200, noun: "error types" }),
		}),
		aliases: P.SERVICE_ALIASES,
		output: FindErrorsOutput,
		hints: { readOnly: true },
		phrases: ["Looking for errors", "Finding errors"],
		handler: Effect.fn("McpTool.findErrors")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, "find_errors")
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				service: params.service ?? "all",
				identity: params.identity ?? "all",
			})

			const errors = yield* findErrors({
				timeRange: { startTime: st, endTime: et },
				service: params.service,
				environment: params.environment,
				identity: params.identity,
				namespacePrefix: params.namespace_prefix,
				limit: params.limit,
			}).pipe(
				provideWarehouseExecutorFromTenant(tenant),
				Effect.mapError(toMcpQueryError("errors_by_type")),
			)

			const identity: typeof FindErrorsOutput.Type.identity = params.identity ?? "all"
			return {
				timeRange: { start: st, end: et },
				identity,
				errors: errors.map((error) => ({
					fingerprintHash: error.fingerprintHash,
					label: error.label,
					sampleMessage: error.sampleMessage,
					count: error.count,
					affectedServicesCount: error.affectedServicesCount,
					lastSeen: error.lastSeen,
				})),
			}
		}),
		render: (output) => {
			const noun = output.identity === "unexpected" ? "unexpected-identity errors" : "errors"
			return {
				title: output.identity === "unexpected" ? "Unexpected Error Identities" : "Errors by Type",
				scope: [["Time range", `${output.timeRange.start} to ${output.timeRange.end}`]],
				...(output.errors.length === 0
					? {
							empty: {
								message: `No ${noun} found in this window.`,
								hints: [
									"Widen start_time/end_time, or drop the service and environment filters.",
								],
							},
						}
					: undefined),
				blocks:
					output.errors.length === 0
						? []
						: [
								// One occurrence's message per row: the same tag can own a dozen fingerprints, and
								// the label alone gave no way to tell them apart short of an error_detail call each.
								doc.table(
									[
										"Error",
										"Message",
										"Fingerprint",
										"Count",
										"Affected Services",
										"Last Seen",
									],
									output.errors.map((error) => [
										truncate(error.label, 60),
										truncate(error.sampleMessage, 80),
										error.fingerprintHash,
										formatNumber(error.count),
										String(error.affectedServicesCount),
										error.lastSeen,
									]),
								),
								doc.text(`Total: ${output.errors.length} error types`),
							],
				next: [
					...output.errors
						.slice(0, 3)
						.map((error) =>
							doc.next(
								"error_detail",
								{ fingerprint: error.fingerprintHash },
								`sample traces and logs for "${error.label}"`,
							),
						),
					...(output.errors.length === 0
						? []
						: [
								doc.next(
									"query_data",
									{ source: "traces", kind: "timeseries", metric: "error_rate" },
									"chart the error rate trend",
								),
							]),
				],
			}
		},
	})
}
