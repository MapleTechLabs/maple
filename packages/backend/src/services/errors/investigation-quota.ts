/**
 * The daily investigation budget, counted in two units.
 *
 * There are two ceilings because there were two costs. A *run* is an
 * investigation — the unit an operator thinks in and configures. A *pass* is one
 * agent turn; an investigation spends exactly one now, so the two ceilings count
 * the same thing, but both stay configurable and both producers read the same
 * query and the same verdict.
 *
 * The second failure this module has to prevent is subtler than a wrong unit: a
 * budget spent is not the same as a budget spent *well*. A single UTC-day bucket
 * handed out first-come-first-served lets whatever errors just after midnight
 * take the whole day, so a `critical` opening at noon is refused by noise that
 * opened at 00:03. {@link RESERVED_PASS_FRACTION} keeps a slice that only the top
 * severities may draw on, which is why the verdict needs to know the severity of
 * the start it is judging.
 */

import { investigations } from "@maple/db"
import type { MapleDbLike } from "@maple/db/client"
import { and, eq, gte, sql } from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { Effect } from "effect"
import type { IssueSeverity, OrgId } from "@maple/domain/http"

/** Runs per UTC day when the org has no row in `ai_triage_settings`. */
export const DEFAULT_MAX_RUNS_PER_DAY = 250

/**
 * Model passes per day when unconfigured. One investigation is one pass, so this
 * is the ceiling the reserve below is carved out of.
 */
export const DEFAULT_MAX_PASSES_PER_DAY = 1000

/**
 * The share of the daily budget only `high` and `critical` may spend.
 *
 * Reserved rather than rationed per-hour on purpose: a token bucket would also
 * stop the overnight sweep from taking everything, but it would delay a genuine
 * 03:00 incident storm just as happily. What actually needs protecting is not
 * evenness across the clock, it is that severity outranks arrival order.
 *
 * It applies to BOTH ceilings. It used to guard passes only, which made it dead
 * code wherever an org configured a run ceiling at all: {@link
 * evaluateInvestigationQuota} tests runs first, and a configured run ceiling is
 * always the smaller of the two, so the reserve was never reached. Measured on
 * the internal org 2026-09-17..19. `maxRunsPerDay` 100 against a 700-pass
 * effective ceiling, every refusal `dimension: "runs"`, the whole day's budget
 * spent between 00:00 and 05:00 UTC on `medium` anomalies, and nothing left for
 * anything that opened while anyone was awake. Exactly the failure the paragraph
 * above describes, in the one dimension it did not cover.
 */
export const RESERVED_PASS_FRACTION = 0.3

/** Severities that may draw on the reserve. */
const PRIORITY_SEVERITIES: ReadonlySet<IssueSeverity> = new Set<IssueSeverity>(["critical", "high"])

export const startOfUtcDay = (nowMs: number): number => {
	const date = new Date(nowMs)
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

export interface InvestigationUsage {
	readonly runs: number
	readonly passes: number
}

/**
 * Today's usage, in both units.
 *
 * Windowed on `started_at`, not `created_at`: a restart re-stamps `started_at`,
 * so restarting an investigation opened last week correctly spends today's
 * budget instead of escaping the window entirely.
 *
 * Takes the drizzle client rather than the `Database` service so both call sites
 * can pass their own `execute` wrapper — `InvestigationService` has `dbExecute`,
 * `maybeEnqueueTriage` has `database.execute`, and neither should have to adopt
 * the other's.
 */
export const selectInvestigationUsage = (
	db: MapleDbLike,
	orgId: OrgId,
	nowMs: number,
): Effect.Effect<InvestigationUsage, EffectDrizzleQueryError> =>
	Effect.map(
		db
			.select({
				runs: sql<number>`count(*)::int`,
				// One agent turn per start.
				passes: sql<number>`count(*)::int`,
			})
			.from(investigations)
			.where(
				and(
					eq(investigations.orgId, orgId),
					gte(investigations.startedAt, new Date(startOfUtcDay(nowMs))),
				),
			),
		(rows) => ({ runs: rows[0]?.runs ?? 0, passes: rows[0]?.passes ?? 0 }),
	)

export interface InvestigationQuotaLimits {
	readonly maxRunsPerDay?: number | null
	readonly maxPassesPerDay?: number | null
}

/**
 * Which ceiling stopped the start.
 *
 * `passes_reserved` is deliberately not folded into `passes`: they call for
 * opposite responses. `passes` means the org is out of budget and the number
 * should go up; `passes_reserved` means the budget is intact but this start was
 * not important enough for what is left, and raising the ceiling would only move
 * the same triage decision later in the day.
 */
export type InvestigationQuotaDimension = "runs" | "runs_reserved" | "passes" | "passes_reserved"

export type InvestigationQuotaVerdict =
	| { readonly kind: "allowed" }
	| {
			readonly kind: "exceeded"
			/** Which ceiling was hit. Reported so a log line says *which* limit to raise. */
			readonly dimension: InvestigationQuotaDimension
			readonly limit: number
			readonly retryableAtMs: number
	  }

/**
 * The ceiling this severity may spend up to, in whichever unit is passed in.
 *
 * An unknown severity is treated as ordinary rather than as priority: the
 * reserve is worth nothing if anything that forgot to classify itself can reach
 * it, and an incident with no severity is far more often noise than an outage.
 */
export const effectiveLimit = (limit: number, severity: IssueSeverity | null | undefined): number => {
	if (severity != null && PRIORITY_SEVERITIES.has(severity)) return limit
	return Math.floor(limit * (1 - RESERVED_PASS_FRACTION))
}

/**
 * Pure verdict, so the whole table is testable without a database.
 *
 * `passCount` is what this start is *about* to spend, which is why passes are
 * checked as `used + requested > limit` while runs are checked as
 * `used >= limit`: a run is one, and counting it twice would make the last slot
 * of the day unusable.
 *
 * `severity` decides which pass ceiling applies. It is optional so the manual
 * path — which can start a free-form question that has no incident and therefore
 * no severity — keeps working; absent reads as ordinary, not as priority.
 */
export const evaluateInvestigationQuota = (input: {
	readonly usage: InvestigationUsage
	readonly limits: InvestigationQuotaLimits | undefined
	readonly passCount: number
	readonly nowMs: number
	readonly severity?: IssueSeverity | null
}): InvestigationQuotaVerdict => {
	const runLimit = input.limits?.maxRunsPerDay ?? DEFAULT_MAX_RUNS_PER_DAY
	const passLimit = input.limits?.maxPassesPerDay ?? DEFAULT_MAX_PASSES_PER_DAY
	const retryableAtMs = startOfUtcDay(input.nowMs) + 24 * 60 * 60 * 1000
	const allowedRuns = effectiveLimit(runLimit, input.severity)
	if (input.usage.runs >= allowedRuns) {
		return {
			kind: "exceeded",
			dimension: allowedRuns < runLimit ? "runs_reserved" : "runs",
			limit: allowedRuns,
			retryableAtMs,
		}
	}
	const allowedPasses = effectiveLimit(passLimit, input.severity)
	if (input.usage.passes + input.passCount > allowedPasses) {
		// Report the ceiling that actually applied, not the configured one — a log
		// line saying "limit 1000" when the start was judged against 700 sends the
		// reader to raise a number that was never the constraint.
		return {
			kind: "exceeded",
			dimension: allowedPasses < passLimit ? "passes_reserved" : "passes",
			limit: allowedPasses,
			retryableAtMs,
		}
	}
	return { kind: "allowed" }
}
