import { Effect, Schema, Array as Arr } from "effect"
import { FindErrorsOutput } from "@maple/domain/mcp-outputs"
import {
	findErrors,
	findErrorsTotals,
	isUnlabelledError,
	labelExceptionlessFingerprints,
} from "@maple/query-engine/observability"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"
import type { McpToolRegistrar } from "./types"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { formatNumber, truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { emptyResultHints } from "../lib/empty-result-hints"

const WINDOW = P.timeWindow({ defaultHours: 6 })

/**
 * Rows shown against everything in the window. Summing the top rows and comparing it with an
 * error-rate chart read as "find_errors misses errors"; the totals say what is and is not here.
 */
const totalsLine = (output: typeof FindErrorsOutput.Type): string => {
	const shownCount = Arr.reduce(output.errors, 0, (sum, e) => sum + e.count)
	const totals = output.totals
	if (totals === undefined) return `Total: ${output.errors.length} error types`
	const lines = [
		`Showing ${output.errors.length} of ${formatNumber(totals.fingerprints)} fingerprints, ${formatNumber(shownCount)} of ${formatNumber(totals.occurrences)} error occurrences in the window.`,
	]
	if (totals.noExceptionCount > 0)
		lines.push(
			`${formatNumber(totals.noExceptionCount)} occurrences are error spans without an exception (status Error only); those rows are labelled by span name and HTTP status where known.`,
		)
	lines.push(
		"Source: spans with status Error. 4xx client spans without an exception are not counted as errors here, though query_data's error_rate counts them.",
	)
	return Arr.join(lines, "\n")
}

export function registerFindErrorsTool(server: McpToolRegistrar) {
	server.define({
		name: "find_errors",
		title: "Find Errors",
		// Do not reinstate the old claim that a fingerprint is the "same identity as
		// list_error_issues" — it is not. A fingerprint is a decimal UInt64 hash; an
		// issue id is a UUID. Conflating them was the sole cause of every production
		// error_detail failure.
		description:
			"Ad-hoc error counts by type and affected services for a time window, with no triage state (tracked issues with workflow state and assignee: list_error_issues). Each error has a stable `fingerprint` (a decimal UInt64): pass it to error_detail for sample traces. The error-issue tools take an `issue_id` UUID from list_error_issues instead.",
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
				"maple.ai.service": params.service ?? "all",
				"maple.ai.identity": params.identity ?? "all",
			})

			const input = {
				timeRange: { startTime: st, endTime: et },
				service: params.service,
				environment: params.environment,
				identity: params.identity,
				namespacePrefix: params.namespace_prefix,
			}
			const [errors, totals] = yield* Effect.all(
				[
					findErrors({ ...input, limit: params.limit }),
					// Context for the rows, not the answer: without it the table still stands.
					findErrorsTotals(input).pipe(Effect.orElseSucceed(() => undefined)),
				],
				{ concurrency: "unbounded" },
			).pipe(
				provideWarehouseExecutorFromTenant(tenant),
				Effect.mapError(toMcpQueryError("errors_by_type")),
			)

			const emptyHints =
				errors.length === 0
					? yield* emptyResultHints(
							{
								service: params.service,
								environments:
									params.environment === undefined ? undefined : [params.environment],
							},
							{ startTime: st, endTime: et },
						)
					: []
			// "Unknown Error" hid what these were (22k bot 404s on one service); name them by span.
			// Cosmetic, so a failed lookup keeps the stored label rather than failing the call.
			const labels = yield* labelExceptionlessFingerprints({
				fingerprintHashes: Arr.map(
					Arr.filter(errors, (e) => isUnlabelledError(e.label)),
					(e) => e.fingerprintHash,
				),
				timeRange: input.timeRange,
			}).pipe(
				provideWarehouseExecutorFromTenant(tenant),
				Effect.orElseSucceed(() => new Map<string, string>()),
			)

			const identity: typeof FindErrorsOutput.Type.identity = params.identity ?? "all"
			return {
				timeRange: { start: st, end: et },
				identity,
				errors: Arr.map(errors, (error) => ({
					fingerprintHash: error.fingerprintHash,
					label: labels.get(error.fingerprintHash) ?? error.label,
					sampleMessage: error.sampleMessage,
					count: error.count,
					affectedServicesCount: error.affectedServicesCount,
					lastSeen: error.lastSeen,
				})),
				...(emptyHints.length > 0 ? { emptyHints } : undefined),
				...(totals === undefined ? undefined : { totals }),
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
									...(output.emptyHints ?? []),
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
									Arr.map(output.errors, (error) => [
										truncate(error.label, 60),
										truncate(error.sampleMessage, 80),
										error.fingerprintHash,
										formatNumber(error.count),
										String(error.affectedServicesCount),
										error.lastSeen,
									]),
								),
								doc.text(totalsLine(output)),
							],
				next: [
					...Arr.map(output.errors.slice(0, 3), (error) =>
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
