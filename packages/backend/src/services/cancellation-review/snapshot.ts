/**
 * Folding raw reads into the snapshot's sections. Pure, so the windowing — the
 * part most likely to be off by a day — is tested without a warehouse.
 *
 * Both windows are whole UTC days counted back from the cancellation: `recent`
 * is the 30 days up to it, `prior` the 30 before.
 */
import type { CancellationSnapshot, DailyVolume } from "@maple/domain/http"
import { timestampMs } from "@maple/backend/platform/time"

export const DAY_MS = 86_400_000
export const WINDOW_DAYS = 30
/** How far back "when did telemetry last arrive" looks; the usage rollup keeps a year. */
const LOOKBACK_DAYS = 365

const startOfUtcDay = (epochMs: number): number => Math.floor(epochMs / DAY_MS) * DAY_MS

/** Whole days between a UTC day and the day of the cancellation; 0 is the same day. */
const daysBefore = (atMs: number, dayMs: number): number =>
	Math.round((startOfUtcDay(atMs) - startOfUtcDay(dayMs)) / DAY_MS)

type Ingest = NonNullable<CancellationSnapshot["ingest"]>
type Visits = NonNullable<CancellationSnapshot["visits"]>
type Billing = NonNullable<CancellationSnapshot["billing"]>

/**
 * The warehouse window `summarizeIngest` expects: a year ending at the
 * cancellation. Only the last 60 days are summed; the rest is there so an org
 * that switched off three months ago is not read as one that never sent anything.
 */
export const ingestWindow = (atMs: number): { readonly startMs: number; readonly endMs: number } => ({
	startMs: startOfUtcDay(atMs) - (LOOKBACK_DAYS - 1) * DAY_MS,
	endMs: atMs,
})

export const summarizeIngest = (days: ReadonlyArray<DailyVolume>, atMs: number): Ingest => {
	const empty = () => ({ logsGB: 0, tracesGB: 0, metricsGB: 0, browserSessions: 0, activeDays: 0 })
	const recent = empty()
	const prior = empty()
	let daysSinceLastData: number | null = null
	for (const day of days) {
		const age = daysBefore(atMs, timestampMs(`${day.date}T00:00:00Z`))
		// Written as the accepted range so an unparseable date (NaN) is skipped too.
		if (!(age >= 0 && age < LOOKBACK_DAYS)) continue
		const active =
			day.logsGB + day.tracesGB + day.metricsGB + day.browserSessions + (day.productEvents ?? 0) > 0
		if (!active) continue
		if (daysSinceLastData === null || age < daysSinceLastData) daysSinceLastData = age
		if (age >= WINDOW_DAYS * 2) continue
		const window = age < WINDOW_DAYS ? recent : prior
		window.logsGB += day.logsGB
		window.tracesGB += day.tracesGB
		window.metricsGB += day.metricsGB
		window.browserSessions += day.browserSessions
		window.activeDays += 1
	}
	return { recent, prior, daysSinceLastData }
}

/**
 * The warehouse window `summarizeVisits` expects. It ends where the day of the
 * cancellation starts: cancelling takes opening the app, so counting that day
 * would have every org "in the app today".
 */
export const visitsWindow = (atMs: number): { readonly startMs: number; readonly endMs: number } => ({
	startMs: startOfUtcDay(atMs) - WINDOW_DAYS * 2 * DAY_MS,
	endMs: startOfUtcDay(atMs) - 1,
})

export const summarizeVisits = (
	days: ReadonlyArray<{ readonly dayMs: number; readonly users: number }>,
	atMs: number,
): Visits => {
	const recent = { activeDays: 0, peakDailyUsers: 0 }
	const prior = { activeDays: 0, peakDailyUsers: 0 }
	let daysSinceLastVisit: number | null = null
	for (const day of days) {
		const age = daysBefore(atMs, day.dayMs)
		// Accepted range, so a bucket that did not parse (NaN) is skipped too.
		if (!(day.users > 0 && age >= 1 && age <= WINDOW_DAYS * 2)) continue
		const window = age <= WINDOW_DAYS ? recent : prior
		window.activeDays += 1
		window.peakDailyUsers = Math.max(window.peakDailyUsers, day.users)
		if (daysSinceLastVisit === null || age < daysSinceLastVisit) daysSinceLastVisit = age
	}
	return { recent, prior, daysSinceLastVisit }
}

/** Drafts and voided invoices were never a bill the org saw. */
const BILLED_STATUSES = new Set(["paid", "open", "uncollectible"])

/** The parts of Autumn's customer the billing section is read from. */
interface BillingInputs {
	readonly balances: Readonly<
		Record<
			string,
			{
				readonly granted?: number | null | undefined
				readonly usage?: number | null | undefined
				readonly unlimited?: boolean | null | undefined
			}
		>
	>
	readonly invoices: ReadonlyArray<{
		readonly status: string
		readonly total: number
		readonly createdAt: number
	}>
}

export const summarizeBilling = ({ balances, invoices }: BillingInputs): Billing => {
	const billed = invoices
		.filter((invoice) => BILLED_STATUSES.has(invoice.status))
		.toSorted((a, b) => b.createdAt - a.createdAt)
	const overAllowance = Object.entries(balances)
		.filter(([, balance]) => {
			const granted = balance.granted ?? 0
			return balance.unlimited !== true && granted > 0 && (balance.usage ?? 0) > granted
		})
		.map(([featureId]) => featureId)
		.toSorted()
	return {
		lastInvoiceTotal: billed[0]?.total ?? null,
		previousInvoiceTotal: billed[1]?.total ?? null,
		overAllowance,
	}
}
