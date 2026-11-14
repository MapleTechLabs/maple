// Shared by the funnel scenario suite: a small product-analytics simulation, its inserts into a
// chDB store, and a reference funnel written in plain TypeScript that the compiled SQL must match.

import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import type { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import { Array as Arr, Option, Order, Record as Rec, Result, String as Str } from "effect"

export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

/** Midnight 25 days back: inside `session_replays`' 30-day TTL for the whole 24-day range. */
export const BASE_MS = Math.floor((Date.now() - 25 * DAY_MS) / DAY_MS) * DAY_MS
export const RANGE_DAYS = 24

export interface SimEvent {
	/** Milliseconds after {@link BASE_MS}. */
	readonly atMs: number
	/** Sub-millisecond part, 0..999: backends stamp finer than a browser does. */
	readonly micro: number
	readonly seq: number
	readonly source: "browser" | "server" | "mobile"
	readonly sessionId: string
	readonly visitorId: string
	readonly userId: string
	readonly kind: "navigation" | "custom" | "screen"
	readonly eventName: string
	readonly host: string
	readonly pagePath: string
	readonly attributes: Readonly<Record<string, string>>
}

export interface SimSession {
	readonly sessionId: string
	readonly visitorId: string
	readonly userId: string
	readonly startMs: number
	readonly referrerHost: string
	readonly utmSource: string
	readonly utmMedium: string
	readonly utmCampaign: string
	readonly country: string
	readonly host: string
	readonly deviceType: string
	readonly browserName: string
}

export interface Dataset {
	readonly orgId: string
	readonly events: ReadonlyArray<SimEvent>
	readonly sessions: ReadonlyArray<SimSession>
}

export const event = (fields: Partial<SimEvent> & Pick<SimEvent, "atMs" | "eventName">): SimEvent => ({
	micro: 0,
	seq: 0,
	source: "browser",
	sessionId: "",
	visitorId: "",
	userId: "",
	kind: "custom",
	host: "",
	pagePath: "",
	attributes: {},
	...fields,
})

export const session = (
	fields: Partial<SimSession> & Pick<SimSession, "sessionId" | "startMs">,
): SimSession => ({
	visitorId: "",
	userId: "",
	referrerHost: "",
	utmSource: "",
	utmMedium: "",
	utmCampaign: "",
	country: "",
	host: "",
	deviceType: "desktop",
	browserName: "Chrome",
	...fields,
})

/** mulberry32: a seeded generator, so every scenario is the same dataset on every run. */
export const seeded = (seed: number) => {
	let state = seed >>> 0
	const next = (): number => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
	return {
		next,
		int: (max: number): number => Math.floor(next() * max),
		chance: (probability: number): boolean => next() < probability,
		pick: <const T extends readonly [unknown, ...ReadonlyArray<unknown>]>(items: T): T[number] =>
			items[Math.floor(next() * items.length)] ?? items[0],
	}
}
export type Rng = ReturnType<typeof seeded>

// Inserts

const quote = (value: string): string =>
	`'${Str.replaceAll("'", "\\'")(Str.replaceAll("\\", "\\\\")(value))}'`

const pad = (value: number, width: number): string => Str.padStart(width, "0")(String(value))

/** `YYYY-MM-DD HH:MM:SS.ffffff` in UTC. */
export const chTimestamp = (offsetMs: number, micro = 0): string =>
	`${Str.replace("T", " ")(Str.slice(0, 23)(new Date(BASE_MS + offsetMs).toISOString()))}${pad(micro, 3)}`

const mapLiteral = (attributes: Readonly<Record<string, string>>): string =>
	`map(${Arr.join(
		Arr.flatMap(Rec.toEntries(attributes), ([key, value]) => [quote(key), quote(value)]),
		", ",
	)})`

const INSERT_CHUNK = 2_000

export const insertDataset = (db: Chdb, dataset: Dataset): void => {
	const org = quote(dataset.orgId)
	Arr.forEach(Arr.chunksOf(dataset.events, INSERT_CHUNK), (chunk) => {
		const rows = Arr.map(
			chunk,
			(row) =>
				`(${org}, ${quote(chTimestamp(row.atMs, row.micro))}, ${quote(row.source)}, ${quote(row.sessionId)}, ${row.seq}, ${quote(row.visitorId)}, ${quote(row.userId)}, ${quote(row.kind)}, ${quote(row.eventName)}, ${quote(row.host)}, ${quote(row.pagePath)}, ${mapLiteral(row.attributes)})`,
		)
		db.exec(
			`INSERT INTO product_events (OrgId, Timestamp, Source, SessionId, Seq, VisitorId, UserId, Kind, EventName, Host, PagePath, Attributes) VALUES ${Arr.join(rows, ", ")}`,
		)
	})
	Arr.forEach(Arr.chunksOf(dataset.sessions, INSERT_CHUNK), (chunk) => {
		const rows = Arr.map(
			chunk,
			(row) =>
				`(${org}, ${quote(row.sessionId)}, ${quote(chTimestamp(row.startMs))}, 'ended', ${quote(row.userId)}, 1, ${quote(row.visitorId)}, ${quote(row.referrerHost)}, ${quote(row.utmSource)}, ${quote(row.utmMedium)}, ${quote(row.utmCampaign)}, ${quote(row.country)}, ${quote(row.host)}, ${quote(row.deviceType)}, ${quote(row.browserName)})`,
		)
		db.exec(
			`INSERT INTO session_replays (OrgId, SessionId, StartTime, Status, UserId, Version, VisitorId, ReferrerHost, UtmSource, UtmMedium, UtmCampaign, Country, Host, DeviceType, BrowserName) VALUES ${Arr.join(rows, ", ")}`,
		)
	})
}

// Running the compiled SQL

export interface Range {
	readonly fromMs: number
	readonly toMs: number
}

export const FULL_RANGE: Range = { fromMs: 0, toMs: RANGE_DAYS * DAY_MS }

const params = (orgId: string, range: Range) => ({
	orgId,
	startTime: Str.slice(0, 19)(chTimestamp(range.fromMs)),
	endTime: Str.slice(0, 19)(chTimestamp(range.toMs)),
})

const decodeFunnel = decodeJsonEachRow(CH.productEventsFunnelRowSchema)
const decodeBreakdown = decodeJsonEachRow(CH.productEventsFunnelBreakdownRowSchema)
const decodeTiming = decodeJsonEachRow(CH.productEventsFunnelTimingRowSchema)
const decodeLeavers = decodeJsonEachRow(CH.productEventsFunnelLeaversRowSchema)

const run = (db: Chdb, sql: string): string => db.query(normalizeSqlForClickHouseClient(sql))

export const sqlFunnel = (
	db: Chdb,
	orgId: string,
	opts: CH.ProductEventsFunnelOpts,
	range: Range = FULL_RANGE,
): ReadonlyArray<number> =>
	Arr.map(
		decodeFunnel(
			run(
				db,
				CH.compileUnsafe(Result.getOrThrow(CH.productEventsFunnelQuery(opts)), params(orgId, range))
					.sql,
			),
		),
		(row) => row.count,
	)

type GroupCounts = readonly [group: string, counts: ReadonlyArray<number>]
export type BreakdownCounts = ReadonlyArray<GroupCounts>

const byEnteredThenName: Order.Order<GroupCounts> = Order.combine(
	Order.flip(Order.mapInput(Order.Number, (entry: GroupCounts) => entry[1][0] ?? 0)),
	Order.mapInput(Order.String, (entry: GroupCounts) => entry[0]),
)

export const sqlBreakdown = (
	db: Chdb,
	orgId: string,
	opts: CH.ProductEventsFunnelBreakdownOpts,
	range: Range = FULL_RANGE,
): BreakdownCounts => {
	const rows = decodeBreakdown(
		run(
			db,
			CH.compileUnsafe(
				Result.getOrThrow(CH.productEventsFunnelBreakdownQuery(opts)),
				params(orgId, range),
			).sql,
		),
	)
	// Keyed with a prefix so the empty group is still a key.
	const byGroup = Arr.groupBy(rows, (row) => `g:${row.group}`)
	return Arr.sort(
		Arr.map(Rec.toEntries(byGroup), ([group, groupRows]): GroupCounts => [
			Str.slice(2)(group),
			Arr.map(
				Arr.sort(
					groupRows,
					Order.mapInput(Order.Number, (row: (typeof rows)[number]) => row.step),
				),
				(row) => row.count,
			),
		]),
		byEnteredThenName,
	)
}

export interface StepTiming {
	readonly step: number
	readonly p50Ms: number
	readonly p90Ms: number
	readonly sinceStartP50Ms: number
	readonly sinceStartP90Ms: number
}

export const sqlTiming = (
	db: Chdb,
	orgId: string,
	opts: CH.ProductEventsFunnelOpts,
	range: Range = FULL_RANGE,
): ReadonlyArray<StepTiming> =>
	decodeTiming(
		run(
			db,
			CH.compileUnsafe(Result.getOrThrow(CH.productEventsFunnelTimingQuery(opts)), params(orgId, range))
				.sql,
		),
	)

type Leaver = readonly [step: number, next: string, count: number]
export type Leavers = ReadonlyArray<Leaver>

export const sqlLeavers = (
	db: Chdb,
	orgId: string,
	opts: CH.ProductEventsFunnelOpts,
	range: Range = FULL_RANGE,
): Leavers =>
	Arr.map(
		decodeLeavers(
			run(
				db,
				CH.compileUnsafe(
					Result.getOrThrow(CH.productEventsFunnelLeaversQuery(opts)),
					params(orgId, range),
				).sql,
			),
		),
		(row): Leaver => [row.step, row.next, row.count],
	)

// The reference funnel
//
// The intended semantics, independent of the SQL: rows ordered by (timestamp, seq). An attempt
// starts at a step-1 row and takes, for each later step, the first later row that matches and is
// still within the window of the start, so one row serves one step. A person's level is their
// deepest attempt, and their chain is the earliest attempt that gets that deep.

type Filters = NonNullable<CH.ProductEventsFunnelOpts["filters"]>

/** The visitor's first linked user, as `identity_links` resolves it. */
const linksOf = (dataset: Dataset): ReadonlyMap<string, string> => {
	const first = new Map<string, { userId: string; startMs: number }>()
	Arr.forEach(dataset.sessions, (row) => {
		if (row.visitorId === "" || row.userId === "") return
		const current = first.get(row.visitorId)
		if (current === undefined || row.startMs < current.startMs)
			first.set(row.visitorId, { userId: row.userId, startMs: row.startMs })
	})
	return new Map(Arr.map([...first], ([visitorId, link]) => [visitorId, link.userId]))
}

const keyOf = (
	keyBy: CH.FunnelKeyBy,
	row: { readonly sessionId: string; readonly visitorId: string; readonly userId: string },
	links: ReadonlyMap<string, string>,
): string => {
	switch (keyBy) {
		case "session":
			return row.sessionId
		case "visitor":
			return row.visitorId
		case "user":
			return row.userId
		case "person":
			return row.userId !== "" ? row.userId : (links.get(row.visitorId) ?? row.visitorId)
	}
}

const SESSION_FIELD = {
	referrerHost: "referrerHost",
	utmSource: "utmSource",
	utmMedium: "utmMedium",
	utmCampaign: "utmCampaign",
	country: "country",
	host: "host",
} as const satisfies Record<CH.FunnelSessionDimension, keyof SimSession>

const inRange = (atMs: number, range: Range): boolean => atMs >= range.fromMs && atMs <= range.toMs

const sessionMatches = (row: SimSession, filters: Filters): boolean =>
	(filters.country === undefined || row.country === filters.country) &&
	(filters.referrerHost === undefined || row.referrerHost === filters.referrerHost) &&
	(filters.utmSource === undefined || row.utmSource === filters.utmSource) &&
	(filters.utmMedium === undefined || row.utmMedium === filters.utmMedium) &&
	(filters.utmCampaign === undefined || row.utmCampaign === filters.utmCampaign) &&
	(filters.deviceType === undefined || row.deviceType === filters.deviceType) &&
	(filters.browserName === undefined || row.browserName === filters.browserName)

const FILTER_FIELDS = [
	"country",
	"referrerHost",
	"utmSource",
	"utmMedium",
	"utmCampaign",
	"deviceType",
	"browserName",
] as const

const hasFilter = (filters: Filters): boolean =>
	Arr.some(FILTER_FIELDS, (field) => filters[field] !== undefined)

const isView = (row: SimEvent): boolean => row.kind === "navigation" || row.kind === "screen"

/** What a row is called in a leavers list: the page or screen for a view, else the event name. */
const displayName = (row: SimEvent): string =>
	isView(row) && row.pagePath !== "" ? row.pagePath : row.eventName

const stepMatches = (step: CH.FunnelStep, row: SimEvent): boolean => {
	switch (step.kind) {
		case "event":
			return (
				row.eventName === step.eventName &&
				Arr.every(
					Rec.toEntries(step.attributeEquals ?? {}),
					([key, value]) => row.attributes[key] === value,
				)
			)
		case "page":
			return (
				isView(row) &&
				row.pagePath === step.pagePath &&
				(step.host === undefined || row.host === step.host)
			)
		case "session":
			return false
	}
}

interface FunnelRow {
	readonly key: string
	/** Microseconds after the base: the order rows are walked in, with `seq` breaking ties. */
	readonly order: number
	readonly seq: number
	readonly atMs: number
	readonly matches: ReadonlyArray<boolean>
	readonly name: string
	readonly dimension: string
}

const byOrder: Order.Order<FunnelRow> = Order.combine(
	Order.mapInput(Order.Number, (row: FunnelRow) => row.order),
	Order.mapInput(Order.Number, (row: FunnelRow) => row.seq),
)

export interface PersonResult {
	readonly key: string
	readonly level: number
	/** The step rows of the person's chain, in step order. */
	readonly chain: ReadonlyArray<FunnelRow>
	readonly group: string
}

/** The attempt starting at `rows[start]`: each later step's first qualifying row. */
const attemptFrom = (
	rows: ReadonlyArray<FunnelRow>,
	start: number,
	stepCount: number,
	windowMicro: number,
): ReadonlyArray<FunnelRow> => {
	const first = rows[start]
	if (first === undefined) return []
	const chain: Array<FunnelRow> = [first]
	let at = start
	for (let step = 1; step < stepCount; step++) {
		const next = Arr.findFirstIndex(
			rows,
			(row, index) =>
				index > at && row.matches[step] === true && row.order <= first.order + windowMicro,
		)
		if (Option.isNone(next)) break
		at = next.value
		const row = rows[at]
		if (row !== undefined) chain.push(row)
	}
	return chain
}

const walk = (
	rows: ReadonlyArray<FunnelRow>,
	stepCount: number,
	windowMicro: number,
): ReadonlyArray<FunnelRow> =>
	Arr.reduce(rows, [] as ReadonlyArray<FunnelRow>, (best, row, index) => {
		if (row.matches[0] !== true) return best
		const attempt = attemptFrom(rows, index, stepCount, windowMicro)
		return attempt.length > best.length ? attempt : best
	})

const dimensionOfEvent = (
	breakdownBy: CH.FunnelBreakdownBy | undefined,
	row: SimEvent,
	sessionsById: ReadonlyMap<string, SimSession>,
	range: Range,
): string => {
	if (breakdownBy === undefined) return ""
	if (Str.startsWith("attribute:")(breakdownBy))
		return row.attributes[Str.slice("attribute:".length)(breakdownBy)] ?? ""
	if (breakdownBy === "host") return row.host
	const owner = sessionsById.get(row.sessionId)
	if (owner === undefined || !inRange(owner.startMs, range)) return ""
	return owner[SESSION_FIELD[breakdownBy as CH.FunnelSessionDimension]]
}

export const referencePersons = (
	dataset: Dataset,
	opts: CH.ProductEventsFunnelOpts,
	range: Range = FULL_RANGE,
	breakdownBy?: CH.FunnelBreakdownBy,
): ReadonlyArray<PersonResult> => {
	const links = linksOf(dataset)
	const filters = opts.filters ?? {}
	const sessionsById = new Map(Arr.map(dataset.sessions, (row) => [row.sessionId, row]))
	const population = hasFilter(filters)
		? new Set(
				Arr.map(
					Arr.filter(
						dataset.sessions,
						(row) => inRange(row.startMs, range) && sessionMatches(row, filters),
					),
					(row) => keyOf(opts.keyBy, row, links),
				),
			)
		: undefined
	const admitted = (key: string): boolean => key !== "" && (population === undefined || population.has(key))

	const eventRows = Arr.flatMap(dataset.events, (row): ReadonlyArray<FunnelRow> => {
		const key = keyOf(opts.keyBy, row, links)
		const matches = Arr.map(opts.steps, (step) => stepMatches(step, row))
		if (!inRange(row.atMs, range) || !admitted(key) || !Arr.some(matches, (matched) => matched)) return []
		return [
			{
				key,
				order: row.atMs * 1000 + row.micro,
				seq: row.seq,
				atMs: row.atMs,
				matches,
				name: displayName(row),
				dimension: dimensionOfEvent(breakdownBy, row, sessionsById, range),
			},
		]
	})
	const first = opts.steps[0]
	const entryRows =
		first?.kind === "session"
			? Arr.flatMap(dataset.sessions, (row): ReadonlyArray<FunnelRow> => {
					const key = keyOf(opts.keyBy, row, links)
					if (!inRange(row.startMs, range) || !admitted(key)) return []
					if (row[SESSION_FIELD[first.dimension]] !== first.value) return []
					const isSessionDimension =
						breakdownBy !== undefined && !Str.startsWith("attribute:")(breakdownBy)
					return [
						{
							key,
							order: row.startMs * 1000,
							seq: 0,
							atMs: row.startMs,
							matches: Arr.map(opts.steps, (_, index) => index === 0),
							name: "$session_entry",
							dimension: isSessionDimension
								? row[SESSION_FIELD[breakdownBy as CH.FunnelSessionDimension]]
								: "",
						},
					]
				})
			: []

	const byKey = Arr.groupBy([...entryRows, ...eventRows], (row) => row.key)
	return Arr.map(Rec.toEntries(byKey), ([key, rows]): PersonResult => {
		const sorted = Arr.sort(rows, byOrder)
		const chain = walk(sorted, opts.steps.length, opts.windowSeconds * 1_000_000)
		return {
			key,
			level: chain.length,
			chain,
			group: Option.match(
				Arr.findFirst(sorted, (row) => row.dimension !== ""),
				{ onNone: () => "", onSome: (row) => row.dimension },
			),
		}
	})
}

const countsOf = (persons: ReadonlyArray<PersonResult>, stepCount: number): ReadonlyArray<number> =>
	Arr.makeBy(stepCount, (index) => Arr.filter(persons, (person) => person.level >= index + 1).length)

export const referenceFunnel = (
	dataset: Dataset,
	opts: CH.ProductEventsFunnelOpts,
	range: Range = FULL_RANGE,
): ReadonlyArray<number> => countsOf(referencePersons(dataset, opts, range), opts.steps.length)

export const referenceBreakdown = (
	dataset: Dataset,
	opts: CH.ProductEventsFunnelBreakdownOpts,
	range: Range = FULL_RANGE,
): BreakdownCounts => {
	const persons = referencePersons(dataset, opts, range, opts.breakdownBy)
	const groups = Arr.groupBy(persons, (person) => person.group)
	return Arr.take(
		Arr.sort(
			Arr.map(Rec.toEntries(groups), ([group, members]): GroupCounts => [
				group,
				countsOf(members, opts.steps.length),
			]),
			byEnteredThenName,
		),
		opts.limit ?? 10,
	)
}

/** ClickHouse's `quantile` over a small set: linear interpolation between the neighbours. */
const quantile = (values: ReadonlyArray<number>, level: number): number => {
	if (values.length === 0) return 0
	const sorted = Arr.sort(values, Order.Number)
	const position = level * (sorted.length - 1)
	const low = Math.floor(position)
	const lower = sorted[low] ?? 0
	const upper = sorted[Math.min(low + 1, sorted.length - 1)] ?? lower
	return lower + (upper - lower) * (position - low)
}

export const referenceTiming = (
	dataset: Dataset,
	opts: CH.ProductEventsFunnelOpts,
	range: Range = FULL_RANGE,
): ReadonlyArray<StepTiming> => {
	const persons = referencePersons(dataset, opts, range)
	return Arr.makeBy(opts.steps.length - 1, (index) => {
		const step = index + 2
		const spansFrom = (from: number) =>
			Arr.flatMap(persons, (person) => {
				const to = person.chain[step - 1]
				const start = person.chain[from]
				return to === undefined || start === undefined ? [] : [to.atMs - start.atMs]
			})
		const previous = spansFrom(step - 2)
		const start = spansFrom(0)
		return {
			step,
			p50Ms: quantile(previous, 0.5),
			p90Ms: quantile(previous, 0.9),
			sinceStartP50Ms: quantile(start, 0.5),
			sinceStartP90Ms: quantile(start, 0.9),
		}
	})
}

export const referenceLeavers = (
	dataset: Dataset,
	opts: CH.ProductEventsFunnelOpts,
	range: Range = FULL_RANGE,
	perStep = 6,
): Leavers => {
	const links = linksOf(dataset)
	const persons = referencePersons(dataset, opts, range)
	const eventsByKey = Arr.groupBy(
		Arr.filter(dataset.events, (row) => inRange(row.atMs, range)),
		(row) => keyOf(opts.keyBy, row, links),
	)
	const nexts = Arr.flatMap(persons, (person) => {
		const last = person.chain[person.level - 1]
		if (last === undefined || person.level >= opts.steps.length) return []
		const later = Arr.sort(
			Arr.filter(
				eventsByKey[person.key] ?? [],
				(row) =>
					row.atMs * 1000 + row.micro > last.order ||
					(row.atMs * 1000 + row.micro === last.order && row.seq > last.seq),
			),
			Order.combine(
				Order.mapInput(Order.Number, (row: SimEvent) => row.atMs * 1000 + row.micro),
				Order.mapInput(Order.Number, (row: SimEvent) => row.seq),
			),
		)
		const next = later[0]
		return [
			{
				step: person.level + 1,
				next: next === undefined ? "" : displayName(next),
			},
		]
	})
	const counted = Arr.map(
		Rec.toEntries(Arr.groupBy(nexts, (entry) => `${entry.step}:${entry.next}`)),
		([, members]): Leaver => [members[0].step, members[0].next, members.length],
	)
	const byCountThenName: Order.Order<Leaver> = Order.combine(
		Order.flip(Order.mapInput(Order.Number, (entry: Leaver) => entry[2])),
		Order.mapInput(Order.String, (entry: Leaver) => entry[1]),
	)
	return Arr.flatMap(Arr.sort(Arr.dedupe(Arr.map(counted, (entry) => entry[0])), Order.Number), (step) =>
		Arr.take(
			Arr.sort(
				Arr.filter(counted, (entry) => entry[0] === step),
				byCountThenName,
			),
			perStep,
		),
	)
}
