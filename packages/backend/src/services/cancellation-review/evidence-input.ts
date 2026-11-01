/**
 * What every evidence reader gets: the org, the moment it cancelled, and the
 * reads the review already made, so no reader repeats one.
 *
 * Times in evidence sections are whole days relative to `atMs`
 * (`…DaysBeforeCancel`, negative after it), so the model never does date math.
 */
import type { OrgId } from "@maple/domain/http"
import { DAY_MS } from "./snapshot"

export interface CancellationEvidenceInput {
	readonly orgId: OrgId
	/** Epoch ms the org decided to cancel. */
	readonly atMs: number
	/** Autumn's raw customer, read with `expand: ["invoices"]`. */
	readonly autumnCustomer: unknown
	readonly stripeCustomerId: string | null
	/** Maple's own org: where the customer's browser sessions and product events live, by `GroupId`. */
	readonly ownOrgId: OrgId | null
	/** The org's members from Clerk; null when Clerk could not be read. */
	readonly members: ReadonlyArray<{ readonly userId: string; readonly email: string }> | null
}

/**
 * Evidence ends here: the visit the org cancelled in can run past the
 * cancellation's timestamp, but what happened later is not why it left. A
 * review that runs late (a retry, a plan reviewed at expiry) must not read it.
 */
export const EVIDENCE_GRACE_MS = 60 * 60 * 1000

/** Whether `ms` falls before the evidence ends. */
export const knownAtCancel = (atMs: number, ms: number): boolean => ms <= atMs + EVIDENCE_GRACE_MS

/**
 * Whole days from `ms` to the cancellation, rounded toward it: the same day is
 * 0 on either side, a day after is -1.
 */
export const daysBeforeCancel = (atMs: number, ms: number): number => Math.trunc((atMs - ms) / DAY_MS) || 0

/**
 * Free text on its way to a third-party model: cut to `max` characters, with
 * addresses, URLs and long tokens (keys, hashes, ids) taken out. Cut before the
 * patterns run, so a huge input never costs more than a short one.
 */
export const redactText = (value: string, max: number): string => {
	const trimmed = value.trim()
	// The cut can split an address or key: the word it cut into is dropped, never half-scrubbed.
	const cut = trimmed.length > max * 2 ? trimmed.slice(0, max * 2).replace(/\S*$/, "") : trimmed
	return cut
		.replaceAll(/[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/gi, "[email]")
		.replaceAll(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
		.replaceAll(/[A-Za-z0-9_-]{24,}/g, "[token]")
		.slice(0, max)
}
