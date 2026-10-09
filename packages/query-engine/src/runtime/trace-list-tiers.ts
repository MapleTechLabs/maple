import { Effect } from "effect"
import type { OrgId } from "@maple/domain"

/**
 * The missing-table config error naming `table`. A timeout or memory error on
 * such a read names the table too, and must surface rather than retry.
 */
const isMissing =
	(table: RegExp) =>
	(error: unknown): boolean => {
		if (typeof error !== "object" || error === null) return false
		const candidate = error as { readonly _tag?: unknown; readonly message?: unknown }
		return (
			candidate._tag === "@maple/http/errors/WarehouseConfigError" &&
			typeof candidate.message === "string" &&
			table.test(candidate.message)
		)
	}

export const isMissingTraceListEntrySpans = isMissing(/trace_list_entry_spans/i)
const isMissingTraceFacetsRollup = isMissing(/trace_facets_hourly/i)

/** The tables beside `trace_list_mv` a trace-list read may use. */
export interface TraceListTiers {
	/** `trace_list_entry_spans`: traces with no root span. */
	readonly rootless: boolean
	/** `trace_facets_hourly`: the facets' whole hours. */
	readonly rollup: boolean
}

/**
 * `trace_facets_hourly` (migration 0034) and `trace_list_entry_spans` (0038)
 * ship in `requiredForIngest: false` migrations, so a cluster may have neither
 * or only the first. A read that named a missing one runs again without it:
 * first without the rootless traces, keeping the rollup, then on `trace_list_mv`
 * alone.
 */
export const withTraceListTierFallback = <A, E, R>(
	orgId: OrgId,
	run: (tiers: TraceListTiers) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
	const retry = (table: string, tiers: TraceListTiers) =>
		Effect.gen(function* () {
			yield* Effect.logWarning(
				`${table} is absent on this cluster; reading without it. Apply ClickHouse schema to restore the full read.`,
			).pipe(Effect.annotateLogs({ orgId }))
			yield* Effect.annotateCurrentSpan("query.rollup.fallback", true)
			return yield* run(tiers)
		})
	return run({ rootless: true, rollup: true }).pipe(
		Effect.catchIf(isMissingTraceListEntrySpans, () =>
			retry("trace_list_entry_spans", { rootless: false, rollup: true }),
		),
		Effect.catchIf(isMissingTraceFacetsRollup, () =>
			retry("trace_facets_hourly", { rootless: false, rollup: false }),
		),
	)
}
