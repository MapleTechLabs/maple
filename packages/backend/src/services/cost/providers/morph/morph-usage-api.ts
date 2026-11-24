/**
 * Morph's usage endpoint, `GET /api/v1/account/usage`: the key's account spend, requests and tokens
 * per UTC day, each day split by model. An organization key reads the organization; a personal key
 * reads its owner's account.
 */
import { Duration, type Redacted, Schema } from "effect"
import type { HttpClient } from "effect/http"
import * as VendorHttp from "../../../integrations/vendor-http"

export const MORPH_API_BASE_URL = "https://api.morphllm.com"
const REQUEST_TIMEOUT = Duration.seconds(20)
/** Morph answers at most this many days after `start` in one request. */
export const MORPH_MAX_RANGE_DAYS = 366

/** `unauthorized`: not a live Morph key. */
export class MorphUsageError extends Schema.TaggedError<MorphUsageError>()(
	"@maple/backend/cost/MorphUsageError",
	{
		message: Schema.String,
		kind: Schema.Literals(["unauthorized", "rate_limited", "invalid_response", "upstream"]),
		status: Schema.optionalKey(Schema.Number),
	},
) {}

const toMorphError = (error: VendorHttp.VendorHttpError): MorphUsageError =>
	new MorphUsageError({
		message: error.message,
		kind:
			error.kind === "unauthorized" ||
			error.kind === "rate_limited" ||
			error.kind === "invalid_response"
				? error.kind
				: "upstream",
		...(error.status === undefined ? undefined : { status: error.status }),
	})

const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u))
const Count = Schema.Number.check(Schema.isFinite())

const counts = {
	/** USD at the account's prices; usage the plan covers counts 0. Rounded to the micro-dollar. */
	spend: Count,
	requests: Count,
	/** Cached input tokens included. */
	inputTokens: Count,
	cachedInputTokens: Count,
	outputTokens: Count,
}

const ModelUsage = Schema.Struct({
	model: Schema.String.check(Schema.isMinLength(1)),
	includedInPlan: Schema.Boolean,
	...counts,
})
export type ModelUsage = typeof ModelUsage.Type

const DayUsage = Schema.Struct({ date: Day, ...counts, models: Schema.Array(ModelUsage) })
export type DayUsage = typeof DayUsage.Type

export const AccountUsage = Schema.Struct({
	account: Schema.Literals(["personal", "organization"]),
	currency: Schema.Literal("USD"),
	start: Day,
	end: Day,
	days: Schema.Array(DayUsage),
})
export type AccountUsage = typeof AccountUsage.Type

/** The account's usage from `range.start` through `range.end`; this month so far without one. */
export const getUsage = (
	httpClient: HttpClient.HttpClient,
	key: Redacted.Redacted,
	range?: { readonly start: string; readonly end: string },
) =>
	VendorHttp.make({
		httpClient,
		peerService: "morph",
		baseUrl: MORPH_API_BASE_URL,
		auth: VendorHttp.bearer(key),
		headers: { accept: "application/json" },
		toError: toMorphError,
		timeout: REQUEST_TIMEOUT,
	}).json(AccountUsage, {
		path: "/api/v1/account/usage",
		...(range === undefined ? undefined : { query: { start: range.start, end: range.end } }),
		operation: "reading usage",
	})
