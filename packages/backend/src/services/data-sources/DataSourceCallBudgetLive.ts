import { DataSourceRateLimitedError } from "@maple/domain/data-sources"
import { Array as Arr, Effect, Layer, Option } from "effect"
import {
	DataSourceDevelopmentCallLimit,
	DataSourceProductionCallLimit,
	type RateLimiter,
} from "@maple/backend/platform/bindings"
import { Env } from "@maple/backend/platform/Env"
import { makeRateLimitCheck } from "@maple/backend/services/auth/ApiV2RateLimiter"
import { DataSourceCallBudget } from "./DataSourceDrivers"

/** 5% of Clerk's per-instance limit (1000 and 100 requests per 10 s), so Maple never causes a 429 in the customer's app. */
export const DATA_SOURCE_CALL_LIMITS = {
	production: { limit: 50, period: 10 },
	development: { limit: 5, period: 10 },
} as const

export const dataSourceCallLimitKey = (sourceId: string): string => `ds:${sourceId}`

/**
 * The call budget on Cloudflare rate-limit bindings. A binding spends one unit per `limit()`,
 * so a batch takes one unit per call and stops at the first refusal (units already taken are
 * not returned). Without the bindings (local, tests) the budget is unlimited.
 */
export const DataSourceCallBudgetLive = Layer.effect(
	DataSourceCallBudget,
	Effect.gen(function* () {
		const env = yield* Env
		const checkFor = (
			limiter: Option.Option<RateLimiter>,
			instance: keyof typeof DATA_SOURCE_CALL_LIMITS,
		) =>
			Option.map(limiter, (binding) => ({
				check: makeRateLimitCheck(Option.some(binding), env.MAPLE_ENVIRONMENT, {
					spanName: "DataSourceCallBudget.check",
					failOpenMessage: "Data source call budget unavailable; allowing call",
				}),
				...DATA_SOURCE_CALL_LIMITS[instance],
			}))
		const production = yield* Effect.serviceOption(DataSourceProductionCallLimit)
		const development = yield* Effect.serviceOption(DataSourceDevelopmentCallLimit)
		const checks = {
			production: checkFor(production, "production"),
			development: checkFor(development, "development"),
		}
		return {
			spend: (source, calls) => {
				if (source.config._tag !== "clerk" || calls < 1) return Effect.void
				const budget = checks[source.config.instance]
				if (Option.isNone(budget)) return Effect.void
				const { check, limit, period } = budget.value
				return Effect.forEach(
					Arr.range(1, calls),
					() =>
						Effect.flatMap(check(dataSourceCallLimitKey(source.id)), (outcome) =>
							outcome === "limited"
								? Effect.fail(
										new DataSourceRateLimitedError({
											message: `Maple's share of this Clerk instance's rate limit (${limit} calls per ${period} s) is used up; retry in a few seconds or lower the refresh rate`,
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
