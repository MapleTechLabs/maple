// Product-event retention and cohorts against a real ClickHouse engine (chDB).
//
// Every expectation comes from the reference below, a plain TypeScript reading of the same rows:
// a key's cohort is the interval of its first start event, period 0 is the cohort's size, and
// period n is the keys of it with a return event n intervals later. The compiled SQL has to agree
// cohort for cohort, including on who is NOT in a cohort because their first event was earlier
// than the window, which is where a hand-written retention query goes wrong.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CH from "@maple/query-engine/ch"
import { Array as Arr, Order, Record as Rec, Result, String as Str } from "effect"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import { describeWithChdb } from "./libchdb-test-support"
import { saasSignup, shopCheckout } from "./funnel-scenarios"
import {
	BASE_MS,
	chTimestamp,
	type Dataset,
	DAY_MS,
	event,
	HOUR_MS,
	inRange,
	insertDataset,
	keyOf,
	linksOf,
	params,
	type Range,
	RANGE_DAYS,
	run,
	seeded,
	stepMatches,
} from "./funnel-scenarios-support"

type Opts = CH.ProductEventsRetentionOpts
type Row = readonly [cohort: string, period: number, count: number]

const decode = decodeJsonEachRow(CH.productEventsRetentionRowSchema)

const sqlRetention = (
	db: Chdb,
	orgId: string,
	opts: Opts,
	range: Range,
	returnEndMs: number,
): ReadonlyArray<Row> =>
	Arr.map(
		decode(
			run(
				db,
				CH.compileUnsafe(Result.getOrThrow(CH.productEventsRetentionQuery(opts)), {
					...params(orgId, range),
					returnEndTime: Str.slice(0, 19)(chTimestamp(returnEndMs)),
				}).sql,
			),
		),
		(row): Row => [row.cohort, row.period, row.count],
	)

// The reference

/** The UTC start of the interval an absolute millisecond falls in. */
const bucketStart = (interval: CH.RetentionInterval, absMs: number): number => {
	const day = Math.floor(absMs / DAY_MS)
	switch (interval) {
		case "day":
			return day * DAY_MS
		case "week":
			// 1970-01-01 was a Thursday: index 3 of a Monday-first week.
			return (day - ((day + 3) % 7)) * DAY_MS
		case "month": {
			const date = new Date(absMs)
			return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
		}
	}
}

const intervalsBetween = (interval: CH.RetentionInterval, fromMs: number, toMs: number): number => {
	switch (interval) {
		case "day":
			return Math.round((toMs - fromMs) / DAY_MS)
		case "week":
			return Math.floor(Math.round((toMs - fromMs) / DAY_MS) / 7)
		case "month": {
			const from = new Date(fromMs)
			const to = new Date(toMs)
			return (
				(to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
			)
		}
	}
}

const dayText = (absMs: number): string => Str.slice(0, 10)(new Date(absMs).toISOString())

const byCohortThenPeriod: Order.Order<Row> = Order.combine(
	Order.mapInput(Order.String, (row: Row) => row[0]),
	Order.mapInput(Order.Number, (row: Row) => row[1]),
)

const referenceRetention = (
	dataset: Dataset,
	opts: Opts,
	range: Range,
	returnEndMs: number,
): ReadonlyArray<Row> => {
	const links = linksOf(dataset)
	const starts = (row: Dataset["events"][number]) =>
		opts.startEvent === undefined || stepMatches(opts.startEvent, row)
	const returns = (row: Dataset["events"][number]) =>
		opts.returnEvent === undefined || stepMatches(opts.returnEvent, row)
	const byKey = Arr.groupBy(
		Arr.filter(dataset.events, (row) => keyOf(opts.keyBy, row, links) !== ""),
		(row) => keyOf(opts.keyBy, row, links),
	)
	const counts = new Map<string, number>()
	const add = (cohortMs: number, period: number) => {
		const id = `${dayText(cohortMs)}|${period}`
		counts.set(id, (counts.get(id) ?? 0) + 1)
	}
	Arr.forEach(Rec.values(byKey), (rows) => {
		// First ever, or first inside the window: the one line the two modes differ on.
		const candidates = Arr.filter(
			rows,
			(row) => starts(row) && row.atMs <= returnEndMs && (opts.firstEver || row.atMs >= range.fromMs),
		)
		if (candidates.length === 0) return
		const firstMs = Math.min(...Arr.map(candidates, (row) => row.atMs))
		if (!inRange(firstMs, range)) return
		const cohortMs = bucketStart(opts.interval, BASE_MS + firstMs)
		add(cohortMs, 0)
		const periods = new Set(
			Arr.filter(
				Arr.map(
					Arr.filter(
						rows,
						(row) => returns(row) && row.atMs >= range.fromMs && row.atMs <= returnEndMs,
					),
					(row) =>
						intervalsBetween(
							opts.interval,
							cohortMs,
							bucketStart(opts.interval, BASE_MS + row.atMs),
						),
				),
				(period) => period >= 1 && period <= opts.periods,
			),
		)
		Arr.forEach([...periods], (period) => add(cohortMs, period))
	})
	return Arr.sort(
		Arr.map([...counts], ([id, count]): Row => {
			const parts = Str.split("|")(id)
			return [parts[0], Number(parts[1] ?? 0), count]
		}),
		byCohortThenPeriod,
	)
}

// Datasets

const ev = (eventName: string): CH.RetentionStep => ({ kind: "event", eventName })
const WHOLE: Range = { fromMs: 0, toMs: RANGE_DAYS * DAY_MS }
const END_MS = RANGE_DAYS * DAY_MS

/** Three people over three weeks, small enough to read the expected table off the rows. */
const HAND: Dataset = {
	orgId: "retention_hand",
	sessions: [],
	events: [
		// Signed up on day 1, back on days 2 and 9.
		event({ atMs: DAY_MS + HOUR_MS, eventName: "signup", userId: "a", source: "server" }),
		event({ atMs: 2 * DAY_MS + HOUR_MS, eventName: "visit", userId: "a", source: "server" }),
		event({ atMs: 9 * DAY_MS + HOUR_MS, eventName: "visit", userId: "a", source: "server" }),
		// Signed up on day 1, never back.
		event({ atMs: DAY_MS + 2 * HOUR_MS, eventName: "signup", userId: "b", source: "server" }),
		// Active since day 0, so a window starting on day 8 has not "acquired" them.
		event({ atMs: HOUR_MS, eventName: "visit", userId: "old", source: "server" }),
		event({ atMs: 8 * DAY_MS + HOUR_MS, eventName: "visit", userId: "old", source: "server" }),
		event({ atMs: 15 * DAY_MS + HOUR_MS, eventName: "visit", userId: "old", source: "server" }),
	],
}

/** Small random histories spread over the range, with accounts shared between people. */
const randomDatasets = (
	count: number,
): ReadonlyArray<{
	readonly dataset: Dataset
	readonly asks: ReadonlyArray<{ readonly opts: Opts; readonly range: Range }>
}> => {
	const rng = seeded(4_211)
	const names = ["a", "b", "c"] as const
	return Arr.makeBy(count, (index) => {
		const people = 3 + rng.int(6)
		const events = Arr.flatMap(Arr.range(1, people), (person) => {
			const userId = rng.chance(0.8) ? `u${person}` : ""
			const visitorId = userId === "" || rng.chance(0.4) ? `v${person}` : ""
			const groupId = rng.chance(0.7) ? `g${person % 2}` : ""
			return Arr.makeBy(1 + rng.int(12), () =>
				event({
					atMs: rng.int(RANGE_DAYS) * DAY_MS + rng.int(23) * HOUR_MS + 1 + rng.int(3_000_000),
					userId,
					visitorId,
					groupId,
					source: "server",
					eventName: rng.pick(names),
				}),
			)
		})
		const asks = Arr.makeBy(6, () => {
			const fromDay = rng.int(10)
			const days = 4 + rng.int(RANGE_DAYS - fromDay - 4)
			return {
				opts: {
					...(rng.chance(0.6) ? { startEvent: ev(rng.pick(names)) } : undefined),
					...(rng.chance(0.5) ? { returnEvent: ev(rng.pick(names)) } : undefined),
					keyBy: rng.pick(["person", "user", "visitor", "group"] as const),
					interval: rng.pick(["day", "week", "week", "month"] as const),
					periods: 1 + rng.int(6),
					firstEver: rng.chance(0.6),
				},
				range: { fromMs: fromDay * DAY_MS, toMs: (fromDay + days) * DAY_MS },
			}
		})
		return { dataset: { orgId: `retention_random_${index}`, events, sessions: [] }, asks }
	})
}

describeWithChdb("product event retention", () => {
	let root: string
	let db: Chdb
	const saas = saasSignup("retention_saas")
	const shop = shopCheckout("retention_shop")
	const random = randomDatasets(40)

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-retention-scenarios-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		Arr.forEach([HAND, saas, shop, ...Arr.map(random, (entry) => entry.dataset)], (dataset) =>
			insertDataset(db, dataset),
		)
	})

	afterAll(() => {
		db?.close()
		if (root) rmSync(root, { recursive: true, force: true })
	})

	const weekly = (firstEver: boolean): Opts => ({
		startEvent: ev("signup"),
		returnEvent: ev("visit"),
		keyBy: "user",
		interval: "day",
		periods: 10,
		firstEver,
	})
	const day = (offset: number): string => Str.slice(0, 10)(chTimestamp(offset * DAY_MS))

	test("a cohort is who first did the start event, and a period is who came back in it", () => {
		expect(sqlRetention(db, HAND.orgId, weekly(true), WHOLE, END_MS)).toEqual([
			[day(1), 0, 2],
			[day(1), 1, 1],
			[day(1), 8, 1],
		])
	})

	test("someone active before the window is in no cohort, unless first-ever is off", () => {
		const anyEvent = (firstEver: boolean): Opts => ({
			keyBy: "user",
			interval: "day",
			periods: 10,
			firstEver,
		})
		const fromDay8: Range = { fromMs: 8 * DAY_MS, toMs: END_MS }
		// `old` was first seen on day 0: with first-ever nobody is new from day 8 on.
		expect(sqlRetention(db, HAND.orgId, anyEvent(true), fromDay8, END_MS)).toEqual([])
		// Read from the window alone, `old` (and `a`, back on day 9) look like new users.
		expect(sqlRetention(db, HAND.orgId, anyEvent(false), fromDay8, END_MS)).toEqual([
			[day(8), 0, 1],
			[day(8), 7, 1],
			[day(9), 0, 1],
		])
	})

	test("returns are followed past the end of the cohort window", () => {
		const firstTwoDays: Range = { fromMs: 0, toMs: 2 * DAY_MS }
		expect(sqlRetention(db, HAND.orgId, weekly(true), firstTwoDays, 2 * DAY_MS)).toEqual([[day(1), 0, 2]])
		expect(sqlRetention(db, HAND.orgId, weekly(true), firstTwoDays, END_MS)).toEqual([
			[day(1), 0, 2],
			[day(1), 1, 1],
			[day(1), 8, 1],
		])
	})

	test("rejects a period count outside 1..26", () => {
		expect(Result.isFailure(CH.productEventsRetentionQuery({ ...weekly(true), periods: 0 }))).toBe(true)
		expect(Result.isFailure(CH.productEventsRetentionQuery({ ...weekly(true), periods: 27 }))).toBe(true)
	})

	// Cohorts: who did one thing and did not do another.

	const decodeCohort = decodeJsonEachRow(CH.productEventsCohortRowSchema)
	type Members = {
		readonly didTotal: number
		readonly total: number
		readonly members: ReadonlyArray<readonly [key: string, count: number]>
	}
	const sqlCohort = (orgId: string, opts: CH.ProductEventsCohortOpts, range: Range): Members => {
		const rows = decodeCohort(
			run(
				db,
				CH.compileUnsafe(Result.getOrThrow(CH.productEventsCohortQuery(opts)), params(orgId, range))
					.sql,
			),
		)
		return {
			didTotal: rows[0]?.didTotal ?? 0,
			total: rows[0]?.total ?? 0,
			members: Arr.map(rows, (row) => [row.key, row.count] as const),
		}
	}
	interface Candidate {
		readonly key: string
		readonly count: number
		readonly lastMs: number
		readonly excluded: boolean
	}
	const latestThenKey: Order.Order<Candidate> = Order.combine(
		Order.mapInput(Order.flip(Order.Number), (entry: Candidate) => entry.lastMs),
		Order.mapInput(Order.String, (entry: Candidate) => entry.key),
	)
	const referenceCohort = (dataset: Dataset, opts: CH.ProductEventsCohortOpts, range: Range): Members => {
		const links = linksOf(dataset)
		const byKey = Arr.groupBy(
			Arr.filter(dataset.events, (row) => keyOf(opts.keyBy, row, links) !== ""),
			(row) => keyOf(opts.keyBy, row, links),
		)
		const keys = Arr.flatMap(Rec.toEntries(byKey), ([key, rows]): ReadonlyArray<Candidate> => {
			const did = Arr.filter(rows, (row) => inRange(row.atMs, range) && stepMatches(opts.did, row))
			if (did.length === 0) return []
			const excluded = Arr.some(
				rows,
				(row) =>
					opts.didNot !== undefined &&
					stepMatches(opts.didNot, row) &&
					row.atMs <= range.toMs &&
					(opts.didNotScope === "ever" || row.atMs >= range.fromMs),
			)
			return [
				{ key, count: did.length, lastMs: Math.max(...Arr.map(did, (row) => row.atMs)), excluded },
			]
		})
		const members = Arr.sort(
			Arr.filter(keys, (entry) => !entry.excluded),
			latestThenKey,
		)
		// Nobody left: the query has no row to carry the totals on.
		return members.length === 0
			? { didTotal: 0, total: 0, members: [] }
			: {
					didTotal: keys.length,
					total: members.length,
					members: Arr.map(
						Arr.take(members, opts.limit),
						(entry) => [entry.key, entry.count] as const,
					),
				}
	}

	test("a cohort is who did one thing in the window and never the other", () => {
		const neverBack: CH.ProductEventsCohortOpts = {
			did: ev("signup"),
			didNot: ev("visit"),
			didNotScope: "ever",
			keyBy: "user",
			limit: 10,
		}
		// `a` signed up and visited; `b` signed up and never came back.
		expect(sqlCohort(HAND.orgId, neverBack, WHOLE)).toEqual({
			didTotal: 2,
			total: 1,
			members: [["b", 1]],
		})
	})

	test("never reaches back before the window, where not-in-the-window does not", () => {
		const visitedLate: Range = { fromMs: 8 * DAY_MS, toMs: END_MS }
		const cohort = (didNotScope: "ever" | "window"): CH.ProductEventsCohortOpts => ({
			did: ev("visit"),
			didNot: ev("signup"),
			didNotScope,
			keyBy: "user",
			limit: 10,
		})
		// `a` visited on day 9 and signed up on day 1, before the window.
		expect(sqlCohort(HAND.orgId, cohort("ever"), visitedLate).members).toEqual([["old", 2]])
		expect(sqlCohort(HAND.orgId, cohort("window"), visitedLate).members).toEqual([
			["old", 2],
			["a", 1],
		])
	})

	test("random histories give the reference's members and totals", () => {
		const rng = seeded(977)
		const names = ["a", "b", "c"] as const
		const asks = Arr.flatMap(random, ({ dataset }) =>
			Arr.makeBy(5, () => {
				const fromDay = rng.int(10)
				const range: Range = { fromMs: fromDay * DAY_MS, toMs: (fromDay + 6 + rng.int(8)) * DAY_MS }
				const opts: CH.ProductEventsCohortOpts = {
					did: ev(rng.pick(names)),
					...(rng.chance(0.7) ? { didNot: ev(rng.pick(names)) } : undefined),
					didNotScope: rng.pick(["ever", "window"] as const),
					keyBy: rng.pick(["person", "user", "visitor", "group"] as const),
					limit: rng.pick([1, 3, 50] as const),
				}
				return { dataset, opts, range, expected: referenceCohort(dataset, opts, range) }
			}),
		)
		const mismatches = Arr.flatMap(asks, ({ dataset, opts, range, expected }) => {
			const actual = sqlCohort(dataset.orgId, opts, range)
			return JSON.stringify(expected) === JSON.stringify(actual)
				? []
				: [{ org: dataset.orgId, opts, range, expected, actual }]
		})
		expect(mismatches.slice(0, 2)).toEqual([])
		// Most asks leave someone in and someone out; an all-empty suite would prove nothing.
		expect(Arr.filter(asks, (ask) => ask.expected.total > 0).length).toBeGreaterThan(60)
	}, 120_000)

	const EXAMPLES: ReadonlyArray<{ readonly name: string; readonly dataset: Dataset; readonly opts: Opts }> =
		[
			{
				name: "weekly retention of sign-ups, per person",
				dataset: saas,
				opts: {
					startEvent: ev("signup_completed"),
					keyBy: "person",
					interval: "week",
					periods: 4,
					firstEver: true,
				},
			},
			{
				name: "daily return of visitors to a shop",
				dataset: shop,
				opts: { keyBy: "visitor", interval: "day", periods: 7, firstEver: true },
			},
			{
				name: "daily repeat purchase, per user",
				dataset: shop,
				opts: {
					startEvent: ev("order_completed"),
					returnEvent: ev("order_completed"),
					keyBy: "user",
					interval: "day",
					periods: 14,
					firstEver: false,
				},
			},
		]

	for (const example of EXAMPLES) {
		test(example.name, () => {
			const expected = referenceRetention(example.dataset, example.opts, WHOLE, END_MS)
			expect(expected.length).toBeGreaterThan(0)
			expect(sqlRetention(db, example.dataset.orgId, example.opts, WHOLE, END_MS)).toEqual(expected)
		})
	}

	test("random histories give the reference's cohorts, in every interval and key", () => {
		const mismatches = Arr.flatMap(random, ({ dataset, asks }) =>
			Arr.flatMap(asks, ({ opts, range }) => {
				const expected = referenceRetention(dataset, opts, range, END_MS)
				const actual = sqlRetention(db, dataset.orgId, opts, range, END_MS)
				return JSON.stringify(expected) === JSON.stringify(actual)
					? []
					: [{ org: dataset.orgId, opts, range, expected, actual }]
			}),
		)
		expect(mismatches.slice(0, 2)).toEqual([])
		// Most asks have cohorts and returns to get wrong; an all-empty suite would prove nothing.
		const answered = Arr.flatMap(random, ({ dataset, asks }) =>
			Arr.filter(asks, ({ opts, range }) =>
				Arr.some(referenceRetention(dataset, opts, range, END_MS), ([, period]) => period > 0),
			),
		)
		expect(answered.length).toBeGreaterThan(100)
	}, 120_000)
})
