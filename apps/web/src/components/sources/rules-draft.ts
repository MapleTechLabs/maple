import { SOURCE_LIMITS } from "@maple/domain/http"
import type { V2Source } from "@maple/domain/http/v2"
import type { SourceAttributeMode, SourceSignal } from "@maple/domain/primitives"
import { useState } from "react"
import { SIGNALS } from "./shared"

export const { maxResourceAttributes: MAX_ATTRIBUTES, maxRateLimitRps: MAX_RATE_LIMIT_RPS } = SOURCE_LIMITS

// An array, not an object: numeric-looking object keys would sort ahead of "never".
export const EXPIRY_CHOICES = [
	{ value: "keep", label: "Keep current" },
	{ value: "never", label: "Never" },
	{ value: "7", label: "7 days" },
	{ value: "30", label: "30 days" },
	{ value: "90", label: "90 days" },
] as const
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number]["value"]
export const isExpiryChoice = (value: string): value is ExpiryChoice =>
	EXPIRY_CHOICES.some((choice) => choice.value === value)

export interface AttributeDraft {
	readonly rowId: string
	readonly key: string
	readonly value: string
	readonly mode: SourceAttributeMode
}

export const newAttributeDraft = (key = "", mode: SourceAttributeMode = "set"): AttributeDraft => ({
	rowId: crypto.randomUUID(),
	key,
	value: "",
	mode,
})

/** Signals, rate limit, resource attributes and expiry, as edited in the form. */
export function useRulesDraft(existing: V2Source | null) {
	const [signals, setSignals] = useState<ReadonlyArray<SourceSignal>>(
		existing?.allowed_signals ?? SIGNALS.map((signal) => signal.value),
	)
	const [rateLimitText, setRateLimitText] = useState(
		existing === null || existing.rate_limit_rps === null ? "" : String(existing.rate_limit_rps),
	)
	const [attributes, setAttributes] = useState<ReadonlyArray<AttributeDraft>>(
		existing === null
			? []
			: existing.resource_attributes.map((attribute) => ({ rowId: crypto.randomUUID(), ...attribute })),
	)
	const [expiry, setExpiry] = useState<ExpiryChoice>(
		existing !== null && existing.expires_at !== null ? "keep" : "never",
	)
	const updateAttribute = (rowId: string, patch: Partial<Omit<AttributeDraft, "rowId">>) =>
		setAttributes((rows) => rows.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)))
	return {
		existing,
		signals,
		setSignals,
		rateLimitText,
		setRateLimitText,
		attributes,
		setAttributes,
		updateAttribute,
		expiry,
		setExpiry,
	}
}

export type RulesDraft = ReturnType<typeof useRulesDraft>
