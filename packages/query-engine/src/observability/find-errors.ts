import { Array as Arr, Effect, pipe } from "effect"
import type { ErrorsByTypeOutput } from "@maple/domain/tinybird"
import * as CH from "../ch"
import { DEFAULT_ERROR_NAMESPACE_PREFIX, UNEXPECTED_IDENTITY_MARKERS } from "../ch/queries/errors"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type { FindErrorsInput } from "./types"
import { toErrorSummary } from "./row-mappers"

export const findErrors = Effect.fn("Observability.findErrors")(function* (input: FindErrorsInput) {
	const executor = yield* WarehouseExecutor

	const result = yield* executor.query<ErrorsByTypeOutput>(
		"errors_by_type",
		{
			start_time: input.timeRange.startTime,
			end_time: input.timeRange.endTime,
			...(input.service && { services: input.service }),
			...(input.environment && { deployment_envs: input.environment }),
			...(input.identity && { identity: input.identity }),
			...(input.namespacePrefix && { namespace_prefix: input.namespacePrefix }),
			limit: input.limit ?? 20,
		},
		{ profile: "aggregation" },
	)

	return pipe(result.data, Arr.map(toErrorSummary))
})

/**
 * Every occurrence behind find_errors' window, not just its top-N rows: the gap between
 * those rows and an error-rate chart was read as "find_errors misses errors".
 */
export const findErrorsTotals = Effect.fn("Observability.findErrorsTotals")(function* (
	input: Omit<FindErrorsInput, "limit">,
) {
	const executor = yield* WarehouseExecutor
	const rows = yield* executor.compiledQuery(
		CH.compile(
			CH.errorsWindowTotalsQuery({
				services: input.service ? [input.service] : undefined,
				deploymentEnvs: input.environment ? [input.environment] : undefined,
				unexpectedIdentity:
					input.identity === "unexpected"
						? {
								namespacePrefix: input.namespacePrefix ?? DEFAULT_ERROR_NAMESPACE_PREFIX,
								markerLabels: UNEXPECTED_IDENTITY_MARKERS,
							}
						: undefined,
			}),
			{
				orgId: executor.orgId,
				startTime: input.timeRange.startTime,
				endTime: input.timeRange.endTime,
			},
		),
		{ profile: "aggregation", context: "errorsWindowTotals" },
	)
	const row = rows[0]
	return {
		occurrences: row?.occurrences ?? 0,
		fingerprints: row?.distinctErrorCount ?? 0,
		noExceptionCount: row?.noExceptionCount ?? 0,
	}
})
