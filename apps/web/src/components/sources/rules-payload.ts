import type { V2SourceUpdateParams } from "@maple/domain/http/v2"
import { MAX_RATE_LIMIT_RPS, type RulesDraft } from "./rules-draft"
import { SIGNALS } from "./shared"

const DAY_MS = 86_400_000

/** Validation and the wire payload derived from a rules draft. */
export function rulesOutcome(draft: RulesDraft) {
	const trimmedRate = draft.rateLimitText.trim()
	const rateLimit = trimmedRate.length === 0 ? null : Number(trimmedRate)
	const rateLimitValid =
		rateLimit === null ||
		(Number.isInteger(rateLimit) && rateLimit >= 1 && rateLimit <= MAX_RATE_LIMIT_RPS)
	const filled = draft.attributes.filter((attribute) => attribute.key.trim().length > 0)
	const keys = filled.map((attribute) => attribute.key.trim())
	const reserved = keys.find((key) => {
		const lower = key.toLowerCase()
		return lower === "org_id" || lower.startsWith("maple_")
	})
	const missingValue = filled.find((attribute) => attribute.value.length === 0)
	const duplicate = keys.find((key, index) => keys.indexOf(key) !== index)
	const attributeProblem =
		reserved !== undefined
			? `"${reserved}" is reserved by Maple.`
			: duplicate !== undefined
				? `"${duplicate}" is listed twice.`
				: missingValue !== undefined
					? `Give "${missingValue.key.trim()}" a value, or remove it.`
					: null
	const valid = draft.signals.length > 0 && rateLimitValid && attributeProblem === null

	// "keep" leaves the stored expiry untouched; it is only offered when editing.
	const expiresAt =
		draft.expiry === "keep"
			? undefined
			: draft.expiry === "never"
				? null
				: new Date(Date.now() + Number(draft.expiry) * DAY_MS).toISOString()

	const payload: V2SourceUpdateParams = {
		allowed_signals:
			draft.signals.length === SIGNALS.length
				? null
				: SIGNALS.map((signal) => signal.value).filter((signal) => draft.signals.includes(signal)),
		rate_limit_rps: rateLimit,
		resource_attributes: filled.map(({ key, value, mode }) => ({ key: key.trim(), value, mode })),
	}
	// `undefined` means keep the stored expiry; callers add `expires_at` only when set.
	return { valid, rateLimitValid, attributeProblem, payload, expiresAt }
}
