// Pure pieces of the cost sync: the head/settle/backfill plan for a source over UTC days, what a
// finished step writes back, and a provider's pull as whole days of `cost_daily` rows.
import { COST_EMPTY_DAY_CATEGORY, type CostProvider } from "@maple/domain/cost"
import type { CostDailyRow } from "@maple/domain/tinybird"
import { DateTime, Option, Order, Array as Arr, Record as Rec, String as Str } from "effect"
import type { CostPullRow, CostPullWindow } from "./CostProvider"

export const COST_DATASOURCE = "cost_daily"

/** Days a head pull covers, the newest served day included: providers keep revising the last few. */
export const HEAD_DAYS = 4
// An hour under a day: a source pulled a few minutes past the hour is due at that hour tomorrow.
export const HEAD_INTERVAL_MS = 23 * 60 * 60_000
// The open months are re-pulled whole about weekly, to pick up what the provider restated.
export const SETTLE_INTERVAL_MS = (7 * 24 - 1) * 60 * 60_000
/**
 * `lastErrorReason` of a source the sync is holding, though nothing failed: the month's request
 * budget is spent, or the org is outside the `cloudCost` rollout.
 */
export const BUDGET_REASON = "budget"
export const ROLLOUT_REASON = "rollout"

/** Whether a source's recorded reason is a hold and not a failed sync. */
export const isCostHold = (reason: string | null): boolean =>
	reason === BUDGET_REASON || reason === ROLLOUT_REASON

/** AWS history goes back to the first day of the month this many months before the current one. */
export const HISTORY_MONTHS = 13
/**
 * OpenRouter serves the last 30 completed UTC days. Two days short of that: a day the API has
 * dropped comes back empty, and an empty day replaces the stored one.
 */
const OPENROUTER_HISTORY_DAYS = 28
/**
 * Cloudflare serves the last year of days. History stops at the first day of the month this many
 * months before the current one, which is always inside that year.
 */
const CLOUDFLARE_HISTORY_MONTHS = 11
/**
 * GitHub's billing report served usage five months back when checked, and its retention is not
 * documented. History stops at the first day of the month this many months back, well inside that.
 */
const GITHUB_HISTORY_MONTHS = 3
/**
 * Vercel serves a year at most in one request, so its history starts at the first day of the month
 * this many months before the current one: a window from there to today is never over a year.
 */
const VERCEL_HISTORY_MONTHS = 11
/**
 * Anthropic's cost report and OpenAI's costs endpoint do not document how far back they serve.
 * History stops at the first day of the month this many months back, a conservative start.
 */
const MODEL_API_HISTORY_MONTHS = 3
/** PlanetScale invoices are read back to the first day of the month this many months before the current one. */
const PLANETSCALE_HISTORY_MONTHS = 12
// Through this day of the month the previous month's bill is still open; the first settle after
// it takes the previous month once more, so its last pull is never from before it closed.
export const PREVIOUS_MONTH_OPEN_DAYS = 10
/** Billable requests in a UTC month from which a source stops walking history until the next month. */
export const BACKFILL_REQUEST_BUDGET = 500
/** Billable requests in a UTC month from which a source pulls nothing at all until the next month. */
export const MONTHLY_REQUEST_BUDGET = 1500

const dayStart = (day: string) => DateTime.makeUnsafe(`${day}T00:00:00Z`)

/** The `YYYY-MM-DD` it is in UTC at `epochMs`. */
export const utcToday = (epochMs: number): string => DateTime.formatIsoDateUtc(DateTime.makeUnsafe(epochMs))

/** The `YYYY-MM` it is in UTC at `epochMs`. */
export const utcMonth = (epochMs: number): string => Str.slice(0, 7)(utcToday(epochMs))

/** `day` moved by `days` (negative for earlier). */
export const addDays = (day: string, days: number): string =>
	DateTime.formatIsoDateUtc(DateTime.add(dayStart(day), { days }))

/** The first day of `day`'s month, moved by `months` (negative for earlier). */
export const monthStart = (day: string, months = 0): string =>
	DateTime.formatIsoDateUtc(DateTime.add(dayStart(`${Str.slice(0, 7)(day)}-01`), { months }))

/** What a provider's cost API serves, which bounds every window the plan asks for. */
interface CostSyncProfile {
	/** The oldest day a pull may ask for, when it is `today` in UTC. */
	readonly floor: (today: string) => string
	/** Days the newest day served trails today: 0 when today itself is served. */
	readonly lagDays: number
	/**
	 * `month`: a head re-pulls the newest day's whole month, not the trailing days, and the month
	 * before it too while that one is still closing. For a provider whose days are shares of a
	 * monthly bill: a new line changes every day of the month.
	 */
	readonly head: "days" | "month"
}

const COST_SYNC_PROFILES = {
	aws: { floor: (today) => monthStart(today, -HISTORY_MONTHS), lagDays: 0, head: "days" },
	openrouter: { floor: (today) => addDays(today, -OPENROUTER_HISTORY_DAYS), lagDays: 1, head: "days" },
	github: { floor: (today) => monthStart(today, -GITHUB_HISTORY_MONTHS), lagDays: 0, head: "days" },
	vercel: { floor: (today) => monthStart(today, -VERCEL_HISTORY_MONTHS), lagDays: 0, head: "days" },
	cloudflare: {
		floor: (today) => monthStart(today, -CLOUDFLARE_HISTORY_MONTHS),
		lagDays: 1,
		head: "days",
	},
	// The open month's invoice is listed, and its days so far are a share of the month's lines.
	planetscale: {
		floor: (today) => monthStart(today, -PLANETSCALE_HISTORY_MONTHS),
		lagDays: 0,
		head: "month",
	},
	anthropic: { floor: (today) => monthStart(today, -MODEL_API_HISTORY_MONTHS), lagDays: 0, head: "days" },
	openai: { floor: (today) => monthStart(today, -MODEL_API_HISTORY_MONTHS), lagDays: 0, head: "days" },
} as const satisfies Record<CostProvider, CostSyncProfile>

/** The oldest day the sync pulls from `provider`. */
export const historyFloor = (provider: CostProvider, today: string): string =>
	COST_SYNC_PROFILES[provider].floor(today)

export const minDay = (a: string, b: string) => (a < b ? a : b)
export const maxDay = (a: string, b: string) => (a > b ? a : b)

const DAY_MS = 86_400_000

/** `count` consecutive days from `startDay`, oldest first; none for a count below 1. */
export const daysFrom = (startDay: string, count: number): ReadonlyArray<string> =>
	count >= 1 ? Arr.makeBy(count, (offset) => addDays(startDay, offset)) : []

/**
 * Every day of a window, oldest first; none when it ends before it starts. Counted from the two
 * instants: day strings stop sorting by date past the year 9999, so a walk to `endDay` may not end.
 */
export const daysOfWindow = (window: CostPullWindow): ReadonlyArray<string> => {
	const elapsedMs =
		DateTime.toEpochMillis(dayStart(window.endDay)) - DateTime.toEpochMillis(dayStart(window.startDay))
	return daysFrom(window.startDay, Math.round(elapsedMs / DAY_MS) + 1)
}

/** The columns a finished step moves. */
export interface CostSyncFrontiers {
	readonly watermarkDate: string | null
	readonly backfillDate: string | null
	readonly lastSyncedAt: number | null
	readonly lastSettledAt: number | null
}

export interface CostSyncState extends CostSyncFrontiers {
	readonly provider: CostProvider
	/** The UTC month (`YYYY-MM`) `requestsCount` counts billable requests in. */
	readonly requestsMonth: string | null
	readonly requestsCount: number
}

export interface CostSyncStep extends CostPullWindow {
	readonly mode: "head" | "settle" | "backfill"
}

/** `budget` names the request budget that keeps a source with work left idle. */
export type CostSyncPlan = CostSyncStep | { readonly mode: "idle"; readonly budget?: "backfill" | "monthly" }

/** Billable requests the source made in the UTC month of `now`: a count from another month is spent. */
export const requestsThisMonth = (
	state: Pick<CostSyncState, "requestsMonth" | "requestsCount">,
	now: number,
): number => (state.requestsMonth === utcMonth(now) ? state.requestsCount : 0)

/** 00:00 UTC on the first day of the month after `now`'s, when a month's request count starts over. */
export const nextMonthStartMs = (now: number): number =>
	DateTime.toEpochMillis(dayStart(monthStart(utcToday(now), 1)))

/** Whether the month before `today`'s is still closing: its bill can change through day 10. */
const previousMonthOpen = (today: string): boolean =>
	Number(Str.slice(8, 10)(today)) <= PREVIOUS_MONTH_OPEN_DAYS

/** Whether the last settle was before day 11 of `day`'s month began, or never: before the month before it closed. */
const settledBeforeClose = (day: string, lastSettledAt: number | null): boolean =>
	lastSettledAt === null ||
	lastSettledAt < DateTime.toEpochMillis(dayStart(addDays(monthStart(day), PREVIOUS_MONTH_OPEN_DAYS)))

// A settle still takes the previous month through day 10, and once after it: when the last settle
// was before day 11 began (or never), the previous month's last pull predates its closing.
const settlesPreviousMonth = (today: string, lastSettledAt: number | null): boolean =>
	previousMonthOpen(today) || settledBeforeClose(today, lastSettledAt)

/**
 * The next pull of a source. SETTLE (the open months, whole) when it is new or a head is due and
 * the last settle is a week old; HEAD (the trailing days) when only the head is due; otherwise one
 * calendar month of BACKFILL until the floor. The month's request budgets stop history first, then all.
 * No window reaches below the provider's floor or past the newest day it serves.
 */
export const planCostSync = (state: CostSyncState, now: number): CostSyncPlan => {
	const requests = requestsThisMonth(state, now)
	if (requests >= MONTHLY_REQUEST_BUDGET) return { mode: "idle", budget: "monthly" }
	const today = utcToday(now)
	const floor = historyFloor(state.provider, today)
	const profile: CostSyncProfile = COST_SYNC_PROFILES[state.provider]
	const latest = addDays(today, -profile.lagDays)
	// The first pull takes the previous month too, so there is something to compare against at once.
	if (state.watermarkDate === null) {
		return { mode: "settle", startDay: maxDay(floor, monthStart(today, -1)), endDay: latest }
	}
	const headDue = state.lastSyncedAt === null || now - state.lastSyncedAt >= HEAD_INTERVAL_MS
	if (headDue) {
		const settleDue = state.lastSettledAt === null || now - state.lastSettledAt >= SETTLE_INTERVAL_MS
		const usualStart = settleDue
			? monthStart(today, settlesPreviousMonth(today, state.lastSettledAt) ? -1 : 0)
			: profile.head === "month"
				? // A closed month keeps changing for days: a branch deleted on its last day is discounted after.
					monthStart(latest, previousMonthOpen(today) ? -1 : 0)
				: addDays(latest, -(HEAD_DAYS - 1))
		// A gap below the usual start: the days up to the watermark were pulled while their month was
		// open and no later window revisits them. Resume a month before the watermark's, so that month
		// and the one before it (still open then, perhaps) get their final amounts.
		const gap = addDays(state.watermarkDate, 1) < usualStart
		// A month head has no gap inside a month, so pulls that stopped over a month end can leave the
		// month before the watermark's on what a settle saw before it closed. This settle takes it.
		const reopens =
			settleDue &&
			profile.head === "month" &&
			settledBeforeClose(state.watermarkDate, state.lastSettledAt)
		const startDay = maxDay(
			floor,
			gap || reopens ? minDay(usualStart, monthStart(state.watermarkDate, -1)) : usualStart,
		)
		return { mode: settleDue ? "settle" : "head", startDay, endDay: latest }
	}
	if (state.backfillDate === null || state.backfillDate <= floor) return { mode: "idle" }
	if (requests >= BACKFILL_REQUEST_BUDGET) return { mode: "idle", budget: "backfill" }
	return {
		mode: "backfill",
		startDay: maxDay(floor, monthStart(state.backfillDate, -1)),
		endDay: addDays(state.backfillDate, -1),
	}
}

/** The frontier columns a finished step writes. Head and settle never move the backfill frontier up. */
export const advanceCostSync = (
	state: CostSyncFrontiers,
	step: CostSyncStep,
	now: number,
): Partial<CostSyncFrontiers> => {
	if (step.mode === "backfill") return { backfillDate: step.startDay }
	const head = {
		watermarkDate: step.endDay,
		lastSyncedAt: now,
		backfillDate: minDay(state.backfillDate ?? step.startDay, step.startDay),
	}
	return step.mode === "settle" ? { ...head, lastSettledAt: now } : head
}

/** Epoch ms as the warehouse's `DateTime64(3)` literal, UTC. */
export const toWarehouseDateTime64 = (epochMs: number): string =>
	Str.replace("T", " ")(Str.slice(0, 23)(DateTime.formatIso(DateTime.makeUnsafe(epochMs))))

/** A usage day as the warehouse's `Date` value: its midnight, UTC. */
const toWarehouseDay = (day: string): string => `${day} 00:00:00`

export interface CostRowContext {
	readonly orgId: string
	readonly sourceId: string
	readonly provider: CostProvider
	/** The pull version every row of the step carries. */
	readonly ingestedAt: string
}

const stamp = (context: CostRowContext, day: string) => ({
	OrgId: context.orgId,
	SourceId: context.sourceId,
	Provider: context.provider,
	Date: toWarehouseDay(day),
	IngestedAt: context.ingestedAt,
})

const toCostDailyRow = (context: CostRowContext, row: CostPullRow): CostDailyRow => ({
	...stamp(context, row.day),
	AccountId: row.accountId,
	CloudService: row.cloudService,
	ServiceCategory: row.serviceCategory,
	UsageType: row.usageType,
	Region: row.region,
	ResourceId: row.resourceId,
	ResourceType: row.resourceType,
	ServiceName: row.serviceName,
	ChargeCategory: row.chargeCategory,
	Basis: row.basis,
	Currency: row.currency,
	BilledCost: row.billedCost,
	EffectiveCost: row.effectiveCost,
	ListCost: row.listCost,
	ConsumedQuantity: row.consumedQuantity,
	ConsumedUnit: row.consumedUnit,
	Tags: { ...row.tags },
	Estimated: row.estimated ? 1 : 0,
})

/** A zero row for a day the pull returned nothing for; reads drop it (it costs nothing). */
const markerRow = (context: CostRowContext, day: string): CostDailyRow => ({
	...stamp(context, day),
	AccountId: "",
	CloudService: "",
	ServiceCategory: "",
	UsageType: "",
	Region: "",
	ResourceId: "",
	ResourceType: "",
	ServiceName: "",
	ChargeCategory: COST_EMPTY_DAY_CATEGORY,
	Basis: "billed",
	Currency: "",
	BilledCost: 0,
	EffectiveCost: 0,
	ListCost: 0,
	ConsumedQuantity: 0,
	ConsumedUnit: "",
	Tags: {},
	Estimated: 0,
})

export interface CostDailyRows {
	readonly rows: ReadonlyArray<CostDailyRow>
	/** Provider rows dropped because their day is not in the window. */
	readonly outsideWindow: number
}

/**
 * A pull as datasource rows, plus one zero marker row per day of the window the pull left empty.
 * Without it a day whose cost vanished on restatement gets no newer version, and readers would
 * keep counting its older rows. A row of a day outside the window is dropped: written, it would
 * version that day with part of a pull.
 */
export const toCostDailyRows = (
	context: CostRowContext,
	pulled: ReadonlyArray<CostPullRow>,
	window: CostPullWindow,
): CostDailyRows => {
	const inWindow = Arr.filter(pulled, (row) => row.day >= window.startDay && row.day <= window.endDay)
	const pulledDays = new Set(Arr.map(inWindow, (row) => row.day))
	return {
		rows: Arr.appendAll(
			Arr.map(inWindow, (row) => toCostDailyRow(context, row)),
			Arr.map(
				Arr.filter(daysOfWindow(window), (day) => !pulledDays.has(day)),
				(day) => markerRow(context, day),
			),
		),
		outsideWindow: pulled.length - inWindow.length,
	}
}

interface Batching {
	readonly batches: ReadonlyArray<ReadonlyArray<CostDailyRow>>
	readonly open: ReadonlyArray<CostDailyRow>
}

const NO_BATCHES: Batching = { batches: [], open: [] }

/** The day of a `cost_daily` row, `YYYY-MM-DD`. */
const dayOfRow = (row: CostDailyRow): string => Str.slice(0, 10)(row.Date)

/** The first day with more than `maxRows` rows, if any: a day one `ingest` request cannot hold. */
export const oversizedDay = (
	rows: ReadonlyArray<CostDailyRow>,
	maxRows: number,
): Option.Option<{ readonly day: string; readonly rows: number }> =>
	Arr.findFirst(
		Arr.sort(
			Rec.toEntries(Arr.groupBy(rows, dayOfRow)),
			Order.mapInput(Order.String, ([day]: readonly [string, unknown]) => day),
		),
		([, dayRows]) => dayRows.length > maxRows,
	).pipe(Option.map(([day, dayRows]) => ({ day, rows: dayRows.length })))

/**
 * Rows as `ingest` batches that hold whole days, oldest day first, each of at most `maxRows`. A
 * day is never split: readers take a day's newest version, so half of one would hide the whole
 * older pull. A day above `maxRows` is a batch of its own, so callers refuse it first (`oversizedDay`).
 */
export const batchWholeDays = (
	rows: ReadonlyArray<CostDailyRow>,
	maxRows: number,
): ReadonlyArray<ReadonlyArray<CostDailyRow>> => {
	const days = Arr.map(
		Arr.sort(
			Rec.toEntries(Arr.groupBy(rows, (row) => row.Date)),
			Order.mapInput(Order.String, ([day]: readonly [string, unknown]) => day),
		),
		([, dayRows]) => dayRows,
	)
	const close = (state: Batching) =>
		state.open.length === 0 ? state.batches : [...state.batches, state.open]
	const packed = Arr.reduce(days, NO_BATCHES, (state, day): Batching =>
		state.open.length + day.length > maxRows
			? { batches: close(state), open: day }
			: { batches: state.batches, open: [...state.open, ...day] },
	)
	return close(packed)
}
