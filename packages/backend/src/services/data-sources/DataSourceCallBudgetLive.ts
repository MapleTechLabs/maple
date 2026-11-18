import { SQL_QUERY_SHARE } from "@maple/data-sources"
import { CLERK_CALL_SHARE } from "@maple/data-sources/clerk"
import { DataSourceRateLimitedError } from "@maple/domain/data-sources"
import { Array as Arr, Effect, Layer, Option } from "effect"
import {
	DataSourceDevelopmentCallLimit,
	DataSourceProductionCallLimit,
	DataSourceSqlQueryLimit,
	type RateLimiter,
} from "@maple/backend/platform/bindings"
import { Env } from "@maple/backend/platform/Env"
import { makeRateLimitCheck } from "@maple/backend/services/auth/ApiV2RateLimiter"
import { DataSourceCallBudget } from "./DataSourceDrivers"

/** The Clerk driver caps each plan at the same share, so a query that fits is never refused mid-run. */
export const DATA_SOURCE_CALL_LIMITS = CLERK_CALL_SHARE

/** What the SQL query binding is declared with: queries per period on one source. */
export const DATA_SOURCE_SQL_QUERY_LIMIT = SQL_QUERY_SHARE

// Keyed by source: two sources on one Clerk instance get a share each. The budget sees only the
// config, never the key, so keying by instance needs a key hash stored on the config first.
export const dataSourceCallLimitKey = (sourceId: string): string => `ds:${sourceId}`

type Share = { readonly limit: number; readonly period: number }

/**
 * The call budget on Cloudflare rate-limit bindings: one unit per call, stopping at the first
 * refusal. Counters are per Cloudflare location, so every figure is approximate. A missing or
 * failing binding lets the call through with a `failed_open` warning.
 */
export const DataSourceCallBudgetLive = Layer.effect(
	DataSourceCallBudget,
	Effect.gen(function* () {
		const env = yield* Env
		const budgetFor = Effect.fnUntraced(function* (
			limiter: Option.Option<RateLimiter>,
			share: Share,
			message: string,
		) {
			const check = makeRateLimitCheck(limiter, env.MAPLE_ENVIRONMENT, {
				spanName: "DataSourceCallBudget.check",
				failOpenMessage: "Data source call budget unavailable; allowing call",
			})
			// Without the binding (local, tests) the warning is said once, not on every call.
			const unbound = yield* Effect.cached(check(""))
			return {
				check: Option.isSome(limiter) ? check : () => unbound,
				period: share.period,
				message,
			}
		})
		const clerkMessage = ({ limit, period }: Share) =>
			`Maple keeps its calls to this Clerk instance to about ${limit} per ${period} s, so it never slows your app, and has used them. Lower the refresh rate if this repeats.`
		const production = yield* Effect.serviceOption(DataSourceProductionCallLimit)
		const development = yield* Effect.serviceOption(DataSourceDevelopmentCallLimit)
		const sqlQueries = yield* Effect.serviceOption(DataSourceSqlQueryLimit)
		const clerk = {
			production: yield* budgetFor(
				production,
				DATA_SOURCE_CALL_LIMITS.production,
				clerkMessage(DATA_SOURCE_CALL_LIMITS.production),
			),
			development: yield* budgetFor(
				development,
				DATA_SOURCE_CALL_LIMITS.development,
				clerkMessage(DATA_SOURCE_CALL_LIMITS.development),
			),
		}
		const sql = yield* budgetFor(
			sqlQueries,
			DATA_SOURCE_SQL_QUERY_LIMIT,
			`Maple's own limit for one data source (about ${DATA_SOURCE_SQL_QUERY_LIMIT.limit} queries per ${DATA_SOURCE_SQL_QUERY_LIMIT.period} s) is reached. Ask for more in one query instead of many.`,
		)
		return {
			spend: (source, calls) => {
				if (calls < 1) return Effect.void
				const { check, message, period } =
					source.config._tag === "clerk" ? clerk[source.config.instance] : sql
				return Effect.forEach(
					Arr.range(1, calls),
					() =>
						Effect.flatMap(check(dataSourceCallLimitKey(source.id)), (outcome) =>
							outcome === "limited"
								? Effect.fail(
										new DataSourceRateLimitedError({
											message,
											retryAfterSeconds: period,
											limitedBy: "maple",
										}),
									)
								: Effect.void,
						),
					{ discard: true },
				)
			},
		}
	}),
)
