// Pure pieces of the cost sync: the head/settle/backfill plan for a source over UTC days, what a
// finished step writes back, and a provider's pull as whole days of `cost_daily` rows.
import { COST_EMPTY_DAY_CATEGORY, type CostProvider } from "@maple/domain/cost"
import type { CostDailyRow } from "@maple/domain/tinybird"
import { DateTime, Option, Order, Array as Arr, Record as Rec, String as Str } from "effect"
import type { CostPullRow, CostPullWindow } from "./CostProvider"

export const COST_DATASOURCE = "cost_daily"

/** Days a head pull covers, today included: providers keep revising the last few. */
export const HEAD_DAYS = 4
// An hour under a day: a source pulled a few minutes past the hour is due at that hour tomorrow.
export const HEAD_INTERVAL_MS = 23 * 60 * 60_000
// The open months are re-pulled whole about weekly, to pick up what the provider restated.
export const SETTLE_INTERVAL_MS = (7 * 24 - 1) * 60 * 60_000
/** History goes back to the first day of the month this many months before the current one. */
export const HISTORY_MONTHS = 13
/** Through this day of the month the previous month's bill is still open. */
export const PREVIOUS_MONTH_OPEN_DAYS = 10

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

/** The oldest day the sync pulls: the first day of the month `HISTORY_MONTHS` before `today`'s. */
export const historyFloor = (today: string): string => monthStart(today, -HISTORY_MONTHS)

const minDay = (a: string, b: string) => (a < b ? a : b)
const maxDay = (a: string, b: string) => (a > b ? a : b)

/** Every day of a window, oldest first; none when it ends before it starts. */
export const daysOfWindow = (window: CostPullWindow): ReadonlyArray<string> =>
	Arr.unfold(window.startDay, (day): Option.Option<readonly [string, string]> =>
		day > window.endDay ? Option.none() : Option.some([day, addDays(day, 1)]),
	)

export interface CostSyncState {
	readonly watermarkDate: string | null
	readonly backfillDate: string | null
	readonly lastSyncedAt: number | null
	readonly lastSettledAt: number | null
}

export interface CostSyncStep extends CostPullWindow {
	readonly mode: "head" | "settle" | "backfill"
}

export type CostSyncPlan = CostSyncStep | { readonly mode: "idle" }

/**
 * The next pull of a source. SETTLE (the open months, whole) when it is new or a head is due and
 * the last settle is a week old; HEAD (the trailing days) when only the head is due; otherwise one
 * calendar month of BACKFILL until the floor.
 */
export const planCostSync = (state: CostSyncState, now: number): CostSyncPlan => {
	const today = utcToday(now)
	// The first pull takes the previous month too, so there is something to compare against at once.
	if (state.watermarkDate === null) {
		return { mode: "settle", startDay: monthStart(today, -1), endDay: today }
	}
	const floor = historyFloor(today)
	const headDue = state.lastSyncedAt === null || now - state.lastSyncedAt >= HEAD_INTERVAL_MS
	if (headDue) {
		const settleDue = state.lastSettledAt === null || now - state.lastSettledAt >= SETTLE_INTERVAL_MS
		const previousMonthOpen = Number(Str.slice(8, 10)(today)) <= PREVIOUS_MONTH_OPEN_DAYS
		const usualStart = settleDue
			? monthStart(today, previousMonthOpen ? -1 : 0)
			: addDays(today, -(HEAD_DAYS - 1))
		// A source held for long resumes from its watermark, so no day between is left unpulled.
		const startDay = maxDay(floor, minDay(usualStart, addDays(state.watermarkDate, 1)))
		return { mode: settleDue ? "settle" : "head", startDay, endDay: today }
	}
	if (state.backfillDate === null || state.backfillDate <= floor) return { mode: "idle" }
	return {
		mode: "backfill",
		startDay: maxDay(floor, monthStart(state.backfillDate, -1)),
		endDay: addDays(state.backfillDate, -1),
	}
}

/** The frontier columns a finished step writes. Head and settle never move the backfill frontier up. */
export const advanceCostSync = (
	state: CostSyncState,
	step: CostSyncStep,
	now: number,
): Partial<CostSyncState> => {
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

/**
 * A pull as datasource rows, plus one zero marker row per day of the window the pull left empty.
 * Without it a day whose cost vanished on restatement gets no newer version, and readers would
 * keep counting its older rows.
 */
export const toCostDailyRows = (
	context: CostRowContext,
	rows: ReadonlyArray<CostPullRow>,
	window: CostPullWindow,
): ReadonlyArray<CostDailyRow> => {
	const pulledDays = new Set(Arr.map(rows, (row) => row.day))
	return Arr.appendAll(
		Arr.map(rows, (row) => toCostDailyRow(context, row)),
		Arr.map(
			Arr.filter(daysOfWindow(window), (day) => !pulledDays.has(day)),
			(day) => markerRow(context, day),
		),
	)
}

interface Batching {
	readonly batches: ReadonlyArray<ReadonlyArray<CostDailyRow>>
	readonly open: ReadonlyArray<CostDailyRow>
}

const NO_BATCHES: Batching = { batches: [], open: [] }

/**
 * Rows as `ingest` batches of at most `maxRows` that hold whole days, oldest day first, so a failed
 * batch never leaves a day half written. Only a day larger than `maxRows` is split, on its own.
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
		day.length > maxRows
			? { batches: [...close(state), ...Arr.chunksOf(day, maxRows)], open: [] }
			: state.open.length + day.length > maxRows
				? { batches: close(state), open: day }
				: { batches: state.batches, open: [...state.open, ...day] },
	)
	return close(packed)
}
