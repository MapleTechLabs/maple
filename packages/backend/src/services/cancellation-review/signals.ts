/**
 * Reading a cancellation snapshot: what it says in plain sentences, and the
 * reason those sentences point to.
 *
 * Every threshold is here, in one file, because the report is only as
 * trustworthy as the reader's ability to check why it said what it said.
 */
import type { CancellationReason, CancellationSnapshot, CancellationVolume } from "@maple/domain/http"
import { WINDOW_DAYS } from "./snapshot"

export interface CancellationSignal {
	/** `concern` argues the org was already gone; `healthy` argues it was not. */
	readonly tone: "concern" | "healthy" | "neutral"
	readonly text: string
}

/** Telemetry on this few days across both windows is a trial run, not adoption. */
const TRIAL_RUN_ACTIVE_DAYS = 3
/** A week without telemetry is a pipeline switched off, not a quiet weekend. */
const STOPPED_AFTER_DAYS = 7
/** Recent volume under this share of the prior window counts as wound down. */
const WOUND_DOWN_RATIO = 0.2
/** Two weeks without a visit while telemetry flows is nobody looking. */
const UNVISITED_AFTER_DAYS = 14
/** So is a month in the app on a quarter of the days of the month before, from a real habit. */
const VISITS_COLLAPSED_RATIO = 0.25
const VISITS_HABIT_DAYS = 8
/** An invoice this many times the one before, and at least `BILL_JUMP_MIN_DOLLARS` more. */
const BILL_JUMP_RATIO = 1.5
const BILL_JUMP_MIN_DOLLARS = 20

export const totalGB = (volume: CancellationVolume): number =>
	volume.logsGB + volume.tracesGB + volume.metricsGB

// A first charge after a $0 trial invoice is the plan starting, not the bill jumping.
const billJumped = (billing: NonNullable<CancellationSnapshot["billing"]>): boolean =>
	billing.lastInvoiceTotal !== null &&
	billing.previousInvoiceTotal !== null &&
	billing.previousInvoiceTotal > 0 &&
	billing.lastInvoiceTotal >= billing.previousInvoiceTotal * BILL_JUMP_RATIO &&
	billing.lastInvoiceTotal - billing.previousInvoiceTotal >= BILL_JUMP_MIN_DOLLARS

type Visits = NonNullable<CancellationSnapshot["visits"]>

const unvisited = (visits: Visits): boolean =>
	visits.daysSinceLastVisit === null || visits.daysSinceLastVisit >= UNVISITED_AFTER_DAYS

const visitsCollapsed = (visits: Visits): boolean =>
	visits.prior.activeDays >= VISITS_HABIT_DAYS &&
	visits.recent.activeDays <= visits.prior.activeDays * VISITS_COLLAPSED_RATIO

/**
 * The reason the metrics alone support, most specific first. `unclear` is what
 * is left when the org looks healthy, and is the honest answer then.
 */
export const ruleReason = (snapshot: CancellationSnapshot): CancellationReason => {
	const { plan, org, ingest, visits, billing } = snapshot
	// Past due on a plan the org itself scheduled to cancel is a choice, with a late invoice.
	if (plan.pastDue && plan.phase === "ended") return "payment_failure"

	if (ingest !== null) {
		const activeDays = ingest.recent.activeDays + ingest.prior.activeDays
		if (ingest.daysSinceLastData === null && org?.everReceivedData !== true) return "never_activated"
		// Only for an org young enough that the two windows are its whole life:
		// a few active days from an older org are the tail of real use.
		const young = (plan.tenureDays ?? org?.ageDays ?? 0) <= WINDOW_DAYS * 2
		if (young && activeDays > 0 && activeDays <= TRIAL_RUN_ACTIVE_DAYS) return "never_activated"
	}

	// Before `stopped_sending`: an org that turns its pipeline off after a bill
	// it did not expect stopped because of the bill.
	if (billing !== null && (billing.overAllowance.length > 0 || billJumped(billing))) return "cost"

	if (ingest !== null) {
		const silent = ingest.daysSinceLastData === null || ingest.daysSinceLastData >= STOPPED_AFTER_DAYS
		const woundDown =
			totalGB(ingest.prior) > 0 && totalGB(ingest.recent) < totalGB(ingest.prior) * WOUND_DOWN_RATIO
		if (silent || woundDown) return "stopped_sending"

		if (visits !== null && (unvisited(visits) || visitsCollapsed(visits))) return "not_engaged"
	}
	return "unclear"
}

export const formatGB = (value: number): string =>
	value >= 10 ? `${Math.round(value)} GB` : value >= 0.1 ? `${value.toFixed(1)} GB` : "<0.1 GB"

const days = (count: number): string => (count === 1 ? "1 day" : `${count} days`)

const dollars = (value: number): string => `$${value.toFixed(value % 1 === 0 ? 0 : 2)}`

/** The snapshot as the sentences a person would pick out of it. Unreadable sections say nothing. */
export const deriveSignals = (snapshot: CancellationSnapshot): ReadonlyArray<CancellationSignal> => {
	const { plan, org, ingest, visits, adoption, billing } = snapshot
	const signals: Array<CancellationSignal> = []
	const add = (tone: CancellationSignal["tone"], text: string) => signals.push({ tone, text })

	if (plan.pastDue) add("concern", "Payment is past due")
	if (plan.trial) add("neutral", "Cancelled during the trial")

	if (ingest !== null) {
		const recent = totalGB(ingest.recent)
		const prior = totalGB(ingest.prior)
		if (ingest.daysSinceLastData === null) {
			add(
				"concern",
				org?.everReceivedData === true ? "No telemetry in the last year" : "Never sent any telemetry",
			)
		} else if (ingest.daysSinceLastData >= STOPPED_AFTER_DAYS) {
			add(
				"concern",
				`Stopped sending telemetry ${days(ingest.daysSinceLastData)} ago${
					prior > 0 ? ` (${formatGB(prior)} the month before)` : ""
				}`,
			)
		} else if (prior > 0 && recent < prior * WOUND_DOWN_RATIO) {
			add("concern", `Telemetry wound down: ${formatGB(recent)} in the last 30 days, ${formatGB(prior)} before`)
		} else if (prior > 0 && recent >= prior * 2) {
			add("neutral", `Telemetry grew: ${formatGB(recent)} in the last 30 days, ${formatGB(prior)} before`)
		} else {
			add(
				"healthy",
				`Still sending telemetry: ${formatGB(recent)} over ${days(ingest.recent.activeDays)} of the last 30`,
			)
		}
	}

	if (visits !== null) {
		if (visits.daysSinceLastVisit === null) {
			add("concern", "Nobody opened the app in the last 60 days")
		} else if (visits.daysSinceLastVisit >= UNVISITED_AFTER_DAYS) {
			add("concern", `Nobody opened the app in ${days(visits.daysSinceLastVisit)}`)
		} else if (visitsCollapsed(visits)) {
			add(
				"concern",
				`Visits fell away: in the app on ${days(visits.recent.activeDays)} of the last 30, ${visits.prior.activeDays} the month before`,
			)
		} else {
			add(
				visits.recent.activeDays >= 8 ? "healthy" : "neutral",
				`In the app on ${days(visits.recent.activeDays)} of the last 30 (${visits.prior.activeDays} the month before), up to ${visits.recent.peakDailyUsers} people a day`,
			)
		}
	}

	if (billing !== null) {
		if (billJumped(billing) && billing.lastInvoiceTotal !== null && billing.previousInvoiceTotal !== null) {
			add(
				"concern",
				`Last invoice ${dollars(billing.lastInvoiceTotal)}, up from ${dollars(billing.previousInvoiceTotal)}`,
			)
		}
		if (billing.overAllowance.length > 0) {
			add("concern", `Past the included allowance on ${billing.overAllowance.join(", ")}`)
		}
	}

	if (adoption !== null) {
		const configured = adoption.dashboards + adoption.alertRules
		if (configured === 0) {
			add("concern", "No dashboards or alert rules set up")
		} else {
			add(
				"neutral",
				`${adoption.dashboards} dashboards, ${adoption.alertRules} alert rules, ${adoption.integrations} integrations`,
			)
		}
	}

	if (plan.tenureDays !== null && plan.tenureDays < 14) {
		add("concern", `Subscribed for only ${days(plan.tenureDays)}`)
	}
	if (org?.members === 1) add("neutral", "Single-member org")
	if (org?.supportChannel === true) add("neutral", "Has a shared support channel")

	return signals
}
