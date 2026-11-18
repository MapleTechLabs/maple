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

/**
 * The call budget on Cloudflare rate-limit bindings. A binding spends one unit per `limit()`,
 * so a batch takes one unit per call and stops at the first refusal (units already taken are
 * not returned). Without the bindings (local, tests) the budget is unlimited, and a binding
 * that errors lets the call through with a warning: both kinds of source are treated alike.
 */
export const DataSourceCallBudgetLive = Layer.effect(
	DataSourceCallBudget,
	Effect.gen(function* () {
		const env = yield* Env
		const checkFor = (
			limiter: Option.Option<RateLimiter>,
			share: { readonly limit: number; readonly period: number },
			describe: (share: { readonly limit: number; readonly period: number }) => string,
		) =>
			Option.map(limiter, (binding) => ({
				check: makeRateLimitCheck(Option.some(binding), env.MAPLE_ENVIRONMENT, {
					spanName: "DataSourceCallBudget.check",
					failOpenMessage: "Data source call budget unavailable; allowing call",
				}),
				period: share.period,
				message: describe(share),
			}))
		const clerkMessage = ({ limit, period }: { readonly limit: number; readonly period: number }) =>
			`Maple's share of this Clerk instance's rate limit (${limit} calls per ${period} s) is used up; retry in a few seconds or lower the refresh rate`
		const production = yield* Effect.serviceOption(DataSourceProductionCallLimit)
		const development = yield* Effect.serviceOption(DataSourceDevelopmentCallLimit)
		const sqlQueries = yield* Effect.serviceOption(DataSourceSqlQueryLimit)
		const clerk = {
			production: checkFor(production, DATA_SOURCE_CALL_LIMITS.production, clerkMessage),
			development: checkFor(development, DATA_SOURCE_CALL_LIMITS.development, clerkMessage),
		}
		const sql = checkFor(
			sqlQueries,
			DATA_SOURCE_SQL_QUERY_LIMIT,
			({ limit, period }) =>
				`Maple runs at most ${limit} queries per ${period} s on one data source, and this one has used them; retry shortly, and ask for more in one query instead of many`,
		)
		return {
			spend: (source, calls) => {
				if (calls < 1) return Effect.void
				const budget = source.config._tag === "clerk" ? clerk[source.config.instance] : sql
				if (Option.isNone(budget)) return Effect.void
				const { check, message, period } = budget.value
				return Effect.forEach(
					Arr.range(1, calls),
					() =>
						Effect.flatMap(check(dataSourceCallLimitKey(source.id)), (outcome) =>
							outcome === "limited"
								? Effect.fail(
										new DataSourceRateLimitedError({
											message,
											retryAfterSeconds: period,
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
