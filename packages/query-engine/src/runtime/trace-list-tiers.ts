import { Effect } from "effect"
import type { OrgId } from "@maple/domain"

/**
 * The missing-table config error naming one of the tables. A timeout or memory
 * error on such a read names it too, and must surface rather than retry.
 */
const isMissingTraceListTier = (error: unknown): boolean => {
	if (typeof error !== "object" || error === null) return false
	const candidate = error as { readonly _tag?: unknown; readonly message?: unknown }
	return (
		candidate._tag === "@maple/http/errors/WarehouseConfigError" &&
		typeof candidate.message === "string" &&
		/trace_facets_hourly|trace_list_entry_spans/i.test(candidate.message)
	)
}

/**
 * `trace_facets_hourly` (migration 0034) and `trace_list_entry_spans` (0038)
 * ship in `requiredForIngest: false` migrations, so a cluster may not have them
 * yet. A read that named one then runs again on `trace_list_mv` alone: no
 * rollup, and no traces without a root span.
 */
export const withRootSpansOnlyFallback = <A, E, R>(
	orgId: OrgId,
	run: (rootsOnly: boolean) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	run(false).pipe(
		Effect.catchIf(isMissingTraceListTier, () =>
			Effect.gen(function* () {
				yield* Effect.logWarning(
					"trace_facets_hourly or trace_list_entry_spans is absent on this cluster; reading trace_list_mv only. Apply ClickHouse schema to restore the full read.",
				).pipe(Effect.annotateLogs({ orgId }))
				yield* Effect.annotateCurrentSpan("query.rollup.fallback", true)
				return yield* run(true)
			}),
		),
	)
