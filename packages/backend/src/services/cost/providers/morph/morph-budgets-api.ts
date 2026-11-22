/**
 * The one Morph endpoint that reports spend: `GET /api/v1/org/members/budgets`, each member's spend
 * on the organization's keys so far this UTC month. Morph serves no usage history, so the cost
 * source keeps readings of this (see `MorphSpendReadings`). Needs an organization key owned by an
 * organization admin; anything else answers 403.
 */
import { Duration, type Redacted, Schema, String as Str } from "effect"
import type { HttpClient } from "effect/http"
import * as VendorHttp from "../../../integrations/vendor-http"

export const MORPH_API_BASE_URL = "https://api.morphllm.com"
const REQUEST_TIMEOUT = Duration.seconds(20)

/** `unauthorized`: not a live Morph key. `forbidden`: not an organization admin's org key. */
export class MorphBudgetsError extends Schema.TaggedError<MorphBudgetsError>()(
	"@maple/backend/cost/MorphBudgetsError",
	{
		message: Schema.String,
		kind: Schema.Literals(["unauthorized", "forbidden", "rate_limited", "invalid_response", "upstream"]),
		status: Schema.optionalKey(Schema.Number),
	},
) {}

const toMorphError = (error: VendorHttp.VendorHttpError): MorphBudgetsError =>
	new MorphBudgetsError({
		message: error.message,
		kind:
			error.kind === "unauthorized" ||
			error.kind === "forbidden" ||
			error.kind === "rate_limited" ||
			error.kind === "invalid_response"
				? error.kind
				: "upstream",
		...(error.status === undefined ? undefined : { status: error.status }),
	})

const DECIMAL_DOLLARS = /^(\d+)(?:\.(\d{1,6}))?$/u

/** A dollar amount as Morph writes it (`"12.34"`), in millionths of a dollar: exact, no float drift. None when it is not one, or too large. */
export const parseMicros = (dollars: string): number | undefined => {
	const match = DECIMAL_DOLLARS.exec(dollars)
	if (match === null) return undefined
	const whole = Number(match[1])
	const fraction = Number(Str.padEnd(6, "0")(match[2] ?? ""))
	const micros = whole * 1_000_000 + fraction
	return Number.isSafeInteger(micros) ? micros : undefined
}

const MemberSpend = Schema.Struct({
	userId: Schema.String.check(Schema.isMinLength(1)),
	/** Dollars as a decimal string, `"12.34"`; read with {@link parseMicros}. */
	spent: Schema.String.check(
		Schema.isPattern(DECIMAL_DOLLARS, { description: "Expected a dollar amount" }),
	),
	email: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type MemberSpend = typeof MemberSpend.Type

export const MemberBudgetList = Schema.Struct({
	month: Schema.String.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/u)),
	members: Schema.Array(MemberSpend),
})
export type MemberBudgetList = typeof MemberBudgetList.Type

/** Every member's spend so far in the month Morph names. */
export const listMemberSpend = (httpClient: HttpClient.HttpClient, key: Redacted.Redacted) =>
	VendorHttp.make({
		httpClient,
		peerService: "morph",
		baseUrl: MORPH_API_BASE_URL,
		auth: VendorHttp.bearer(key),
		headers: { accept: "application/json" },
		toError: toMorphError,
		timeout: REQUEST_TIMEOUT,
	}).json(MemberBudgetList, { path: "/api/v1/org/members/budgets", operation: "reading member spend" })
