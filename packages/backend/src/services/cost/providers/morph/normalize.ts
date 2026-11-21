// Morph's month-to-date readings as `cost_daily` rows. A member's cost on a day is the day's last
// reading less their last reading before it in the same month. What a member had spent by the
// month's first reading happened before Maple read anything, so it is booked on the month's first
// day as one row of its own.
import { Array as Arr, Order, Record as Rec } from "effect"
import type { CostPullRow, CostPullWindow } from "../../CostProvider"
import { monthStart } from "../../sync-plan"

/** The `cloud_service` of every Morph row: Morph reports no split by model. */
export const MORPH_SERVICE = "morph"
/** The usage type of the spend from before the month's first reading. */
export const BEFORE_FIRST_READING = "Spend before the month's first reading"
const USAGE = "Usage"
const CATEGORY = "AI and Machine Learning"

/** One member's readings on one day: the first and the last of the day. */
export interface MorphDayReading {
	/** `YYYY-MM`, the month the spend covers. */
	readonly month: string
	/** `YYYY-MM-DD`, inside `month`. */
	readonly day: string
	readonly memberId: string
	readonly memberLabel: string
	readonly openingMicros: number
	readonly closingMicros: number
}

const byDay = Order.mapInput(Order.String, (reading: MorphDayReading) => reading.day)

const row = (
	day: string,
	accountId: string,
	reading: MorphDayReading,
	usageType: string,
	micros: number,
	estimated: boolean,
): CostPullRow => {
	const dollars = micros / 1_000_000
	return {
		day,
		accountId,
		cloudService: MORPH_SERVICE,
		serviceCategory: CATEGORY,
		usageType,
		region: "global",
		resourceId: reading.memberLabel,
		resourceType: "member",
		serviceName: "",
		// Morph can lower a month's spend (a refund): the drop is a correction, not negative usage.
		chargeCategory: micros < 0 ? "adjustment" : "usage",
		basis: "billed",
		currency: "USD",
		billedCost: dollars,
		effectiveCost: dollars,
		listCost: dollars,
		consumedQuantity: 0,
		consumedUnit: "",
		tags: { "morph.user_id": reading.memberId },
		estimated,
	}
}

/** One month's rows. `openDay`: the newest day read, whose spend is still growing. */
const monthRows = (
	readings: Arr.NonEmptyReadonlyArray<MorphDayReading>,
	accountId: string,
	openDay: string,
): ReadonlyArray<CostPullRow> => {
	const firstDay = Arr.min(
		Arr.map(readings, (reading) => reading.day),
		Order.String,
	)
	// Read on the month's first day, nothing came before: the day counts from zero.
	const lumpDay = firstDay === monthStart(firstDay) ? undefined : firstDay
	const members = Rec.values(Arr.groupBy(readings, (reading) => reading.memberId))
	// One name per member on every day: the newest one Morph gave. A name two members end up with
	// (an email moved on) takes the member's id, so their rows never merge into one.
	const newestLabels = Arr.map(
		members,
		(memberReadings) => Arr.lastNonEmpty(Arr.sort(memberReadings, byDay)).memberLabel,
	)
	const shared = new Set(
		Rec.keys(
			Rec.filter(
				Arr.groupBy(newestLabels, (label) => label),
				(same) => same.length > 1,
			),
		),
	)
	return Arr.flatMap(members, (memberReadings) => {
		const sorted = Arr.sort(memberReadings, byDay)
		const newest = Arr.lastNonEmpty(sorted)
		const label = shared.has(newest.memberLabel)
			? `${newest.memberLabel} (${newest.memberId})`
			: newest.memberLabel
		const days = Arr.map(sorted, (reading) => ({ ...reading, memberLabel: label }))
		return Arr.flatMap(days, (reading, index): ReadonlyArray<CostPullRow> => {
			const previous = index === 0 ? undefined : days[index - 1]
			// A member first seen after the month's first reading joined later: from zero.
			const before =
				previous !== undefined
					? previous.closingMicros
					: reading.day === lumpDay
						? reading.openingMicros
						: 0
			const spent = reading.closingMicros - before
			const today =
				spent === 0
					? []
					: [row(reading.day, accountId, reading, USAGE, spent, reading.day >= openDay)]
			if (previous !== undefined || reading.day !== lumpDay || reading.openingMicros === 0) return today
			return [
				row(
					monthStart(reading.day),
					accountId,
					reading,
					BEFORE_FIRST_READING,
					reading.openingMicros,
					false,
				),
				...today,
			]
		})
	})
}

/**
 * The window's rows from every reading of the months it touches: a day's cost needs the readings
 * before it in its month, so callers pass whole months and get only the window's days back.
 */
export const toCostRows = (
	readings: ReadonlyArray<MorphDayReading>,
	accountId: string,
	window: CostPullWindow,
	openDay: string,
): ReadonlyArray<CostPullRow> =>
	Arr.filter(
		Arr.flatMap(Rec.values(Arr.groupBy(readings, (reading) => reading.month)), (month) =>
			monthRows(month, accountId, openDay),
		),
		(costRow) => costRow.day >= window.startDay && costRow.day <= window.endDay,
	)
