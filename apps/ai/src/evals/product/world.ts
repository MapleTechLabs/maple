/**
 * The product the scenarios ask about: Acme, a B2B SaaS with a marketing site and an app.
 *
 * Eight whole weeks of history ending at the last UTC Monday, generated from a fixed seed, so the
 * same people do the same things on every run and only the calendar dates move. It has the shapes
 * that make product questions go wrong on real data:
 *
 * - accounts (`GroupId`) with one to three users each, so "accounts" and "users" differ;
 * - `signup_completed` sent by the backend with a user id and nothing else;
 * - `plan_started` sent by the billing webhook with an account id and no user;
 * - anonymous marketing visits that become a user after sign-up (an identity link);
 * - sessions only for the last three weeks, as `session_replays` keeps 30 days.
 *
 * Every expected answer is read from these rows by the plain functions at the bottom, never
 * from the SQL under test.
 */
import { Array as Arr, Order, Record as Rec, String as Str } from "effect"

export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000
export const WEEK_MS = 7 * DAY_MS

export const WORLD_WEEKS = 8
/** Sessions exist for the last three weeks only. */
export const SESSION_WEEKS = 3

const ACCOUNTS = 70
const ANONYMOUS_VISITORS = 320

export const MARKETING_HOST = "acme.test"
export const APP_HOST = "app.acme.test"

export interface WorldEvent {
	readonly atMs: number
	readonly source: "browser" | "server"
	readonly sessionId: string
	readonly seq: number
	readonly visitorId: string
	readonly userId: string
	readonly groupId: string
	readonly kind: "navigation" | "custom"
	readonly eventName: string
	readonly host: string
	readonly pagePath: string
	readonly attributes: Readonly<Record<string, string>>
}

export interface WorldSession {
	readonly sessionId: string
	readonly startMs: number
	readonly visitorId: string
	readonly userId: string
	readonly groupId: string
	readonly host: string
	readonly country: string
	readonly deviceType: string
	readonly browserName: string
	readonly referrerHost: string
	readonly utmSource: string
	readonly utmMedium: string
	readonly utmCampaign: string
}

export interface WorldUser {
	readonly userId: string
	readonly groupId: string
	readonly visitorId: string
	readonly signupMs: number
	readonly signupWeek: number
}

export interface WorldAccount {
	readonly groupId: string
	readonly plan: "free" | "pro" | "team"
}

export interface World {
	/** Monday 00:00 UTC, eight weeks before `endMs`. */
	readonly startMs: number
	/** The last Monday 00:00 UTC: exclusive end of the history. */
	readonly endMs: number
	readonly accounts: ReadonlyArray<WorldAccount>
	readonly users: ReadonlyArray<WorldUser>
	readonly events: ReadonlyArray<WorldEvent>
	readonly sessions: ReadonlyArray<WorldSession>
}

/** mulberry32: a seeded generator, so the world is the same on every run. */
const seeded = (seed: number) => {
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
		pick: <T>(items: readonly [T, ...ReadonlyArray<T>]): T =>
			items[Math.floor(next() * items.length)] ?? items[0],
	}
}

const pad = (value: number, width: number): string => Str.padStart(width, "0")(String(value))

/** The UTC Monday 00:00 at or before `ms`. */
export const mondayOf = (ms: number): number => {
	const day = Math.floor(ms / DAY_MS)
	// 1970-01-01 was a Thursday: day 4 of a Monday-first week is index 3.
	return (day - ((day + 3) % 7)) * DAY_MS
}

const SOURCES = [
	{ utmSource: "google", utmMedium: "cpc", utmCampaign: "brand", referrerHost: "www.google.com" },
	{ utmSource: "google", utmMedium: "cpc", utmCampaign: "brand", referrerHost: "www.google.com" },
	{ utmSource: "google", utmMedium: "cpc", utmCampaign: "brand", referrerHost: "www.google.com" },
	{ utmSource: "newsletter", utmMedium: "email", utmCampaign: "october", referrerHost: "" },
	{ utmSource: "newsletter", utmMedium: "email", utmCampaign: "october", referrerHost: "" },
	{ utmSource: "twitter", utmMedium: "social", utmCampaign: "launch", referrerHost: "t.co" },
	{ utmSource: "", utmMedium: "", utmCampaign: "", referrerHost: "" },
] as const
const COUNTRIES = ["US", "US", "US", "US", "DE", "DE", "DE", "GB", "GB", "FR", "IN"] as const
const DEVICES = ["desktop", "desktop", "desktop", "mobile"] as const
const FORMATS = ["csv", "csv", "csv", "csv", "csv", "csv", "pdf", "pdf", "pdf", "xlsx"] as const
const PLAN_AMOUNT = { pro: "29", team: "99" } as const

export const makeWorld = (nowMs: number): World => {
	const endMs = mondayOf(nowMs)
	const startMs = endMs - WORLD_WEEKS * WEEK_MS
	const sessionsFromMs = endMs - SESSION_WEEKS * WEEK_MS
	const rng = seeded(20_261_122)

	const events: Array<WorldEvent> = []
	const sessions: Array<WorldSession> = []
	const users: Array<WorldUser> = []
	const accounts: Array<WorldAccount> = []
	const profiles = new Map<string, Pick<WorldSession, "country" | "deviceType">>()
	let sessionCount = 0

	/** One browser session: its row (when recent enough to still exist) and its events, in order. */
	const browse = (
		who: Pick<WorldSession, "visitorId" | "userId" | "groupId" | "host">,
		startAt: number,
		acquisition: (typeof SOURCES)[number],
		steps: ReadonlyArray<{
			readonly afterMs: number
			readonly page?: string
			readonly event?: string
			readonly attributes?: Readonly<Record<string, string>>
		}>,
	): void => {
		sessionCount += 1
		const sessionId = `s_${pad(sessionCount, 5)}`
		// Where someone is and what they browse on stays theirs across sessions.
		const profile = profiles.get(who.visitorId) ?? {
			country: rng.pick(COUNTRIES),
			deviceType: rng.pick(DEVICES),
		}
		profiles.set(who.visitorId, profile)
		if (startAt >= sessionsFromMs) {
			sessions.push({
				sessionId,
				startMs: startAt,
				...who,
				...profile,
				browserName: "Chrome",
				...acquisition,
			})
		}
		let at = startAt
		Arr.forEach(steps, (step, index) => {
			at += step.afterMs
			if (at >= endMs) return
			events.push({
				atMs: at,
				source: "browser",
				sessionId,
				seq: index + 1,
				visitorId: who.visitorId,
				userId: who.userId,
				groupId: who.groupId,
				kind: step.page === undefined ? "custom" : "navigation",
				eventName: step.event ?? "$pageview",
				host: who.host,
				pagePath: step.page ?? "",
				attributes: step.attributes ?? {},
			})
		})
	}

	const server = (
		atMs: number,
		eventName: string,
		ids: { readonly userId?: string; readonly groupId?: string },
		attributes: Readonly<Record<string, string>>,
	): void => {
		if (atMs >= endMs) return
		events.push({
			atMs,
			source: "server",
			sessionId: "",
			seq: 0,
			visitorId: "",
			userId: ids.userId ?? "",
			groupId: ids.groupId ?? "",
			kind: "custom",
			eventName,
			host: "",
			pagePath: "",
			attributes,
		})
	}

	const DIRECT = SOURCES[6]

	// Accounts are created across the first seven weeks.
	Arr.forEach(
		Arr.makeBy(ACCOUNTS, (index) => index),
		(index) => {
			const groupId = `acct_${pad(index + 1, 2)}`
			const plan = index % 5 === 0 ? "team" : index % 5 <= 2 ? "pro" : "free"
			accounts.push({ groupId, plan })
			const createdWeek = index % 7
			const createdMs =
				startMs + createdWeek * WEEK_MS + rng.int(4) * DAY_MS + (9 + rng.int(8)) * HOUR_MS
			const members = 1 + rng.int(3)

			Arr.forEach(
				Arr.makeBy(members, (member) => member),
				(member) => {
					const userId = `u_${pad(users.length + 1, 3)}`
					const visitorId = `v_${userId}`
					// The first member creates the account; the others join over the next two days.
					const signupMs = createdMs + (member === 0 ? 0 : (1 + rng.int(40)) * HOUR_MS)
					const signupWeek = Math.floor((signupMs - startMs) / WEEK_MS)
					users.push({ userId, groupId, visitorId, signupMs, signupWeek })
					const acquisition = rng.pick(SOURCES)

					// The anonymous marketing visit before sign-up: same visitor, no user yet.
					browse(
						{ visitorId, userId: "", groupId: "", host: MARKETING_HOST },
						signupMs - 25 * MINUTE_MS,
						acquisition,
						[
							{ afterMs: 0, page: "/" },
							...(rng.chance(0.7) ? [{ afterMs: 3 * MINUTE_MS, page: "/pricing" }] : []),
							{ afterMs: 4 * MINUTE_MS, page: "/signup" },
						],
					)
					server(
						signupMs,
						"signup_completed",
						{ userId },
						{ method: rng.chance(0.6) ? "google" : "email" },
					)

					// Onboarding, in the first app session.
					const createsWorkspace = member === 0 || rng.chance(0.75)
					const invites = createsWorkspace && rng.chance(0.55)
					browse({ visitorId, userId, groupId, host: APP_HOST }, signupMs + 2 * MINUTE_MS, DIRECT, [
						{ afterMs: 0, page: "/welcome" },
						...(createsWorkspace ? [{ afterMs: 2 * MINUTE_MS, event: "workspace_created" }] : []),
						...(invites
							? [{ afterMs: MINUTE_MS, event: "invite_sent" }]
							: [{ afterMs: MINUTE_MS, page: `/dashboards/d${1 + rng.int(40)}` }]),
					])
					// A project follows for most: soon for the majority, after the first week for a few.
					if (createsWorkspace && rng.chance(0.7)) {
						const late = rng.chance(0.2)
						const projectMs =
							signupMs + (late ? (8 + rng.int(4)) * DAY_MS : (2 + rng.int(60)) * HOUR_MS)
						browse(
							{ visitorId, userId, groupId, host: APP_HOST },
							projectMs - 2 * MINUTE_MS,
							DIRECT,
							[
								{ afterMs: 0, page: "/projects" },
								{
									afterMs: 2 * MINUTE_MS,
									event: "project_created",
									attributes: { template: rng.pick(["blank", "blank", "starter"]) },
								},
							],
						)
					}

					// Weekly activity after the sign-up week, decaying; paying accounts stay longer.
					const [base, decay] = plan === "free" ? [0.45, 0.7] : [0.8, 0.85]
					Arr.forEach(
						Arr.makeBy(WORLD_WEEKS, (week) => week),
						(week) => {
							if (week <= signupWeek) return
							if (!rng.chance(base * decay ** (week - signupWeek - 1))) return
							Arr.forEach(
								Arr.makeBy(1 + rng.int(3), (visit) => visit),
								() => {
									const at =
										startMs +
										week * WEEK_MS +
										rng.int(7) * DAY_MS +
										(8 + rng.int(10)) * HOUR_MS +
										rng.int(50) * MINUTE_MS
									const exports = rng.chance(0.5)
									browse({ visitorId, userId, groupId, host: APP_HOST }, at, DIRECT, [
										{ afterMs: 0, page: `/dashboards/d${1 + rng.int(40)}` },
										{ afterMs: 2 * MINUTE_MS, page: "/reports" },
										...(exports
											? [
													{
														afterMs: MINUTE_MS,
														event: "report_exported",
														attributes: { format: rng.pick(FORMATS) },
													},
												]
											: []),
									])
								},
							)
						},
					)

					// Billing: the account's first user starts checkout; the webhook reports the plan.
					if (member === 0 && (plan !== "free" || index % 4 === 3)) {
						const checkoutMs = createdMs + (2 + rng.int(8)) * DAY_MS + 3 * HOUR_MS
						const wanted = plan === "free" ? "pro" : plan
						browse(
							{ visitorId, userId, groupId, host: APP_HOST },
							checkoutMs - MINUTE_MS,
							DIRECT,
							[
								{ afterMs: 0, page: "/settings/billing" },
								{
									afterMs: MINUTE_MS,
									event: "checkout_started",
									attributes: { plan: wanted },
								},
							],
						)
						if (plan !== "free" && rng.chance(0.85)) {
							server(
								checkoutMs + 5 * MINUTE_MS,
								"plan_started",
								{ groupId },
								{ plan, amount: PLAN_AMOUNT[plan] },
							)
						}
					}
				},
			)
		},
	)

	// Marketing visitors who never sign up, in the weeks that still have sessions.
	Arr.forEach(
		Arr.makeBy(ANONYMOUS_VISITORS, (index) => index),
		(index) => {
			const visitorId = `v_anon_${pad(index + 1, 3)}`
			const at =
				sessionsFromMs +
				rng.int(SESSION_WEEKS * 7) * DAY_MS +
				rng.int(24) * HOUR_MS +
				rng.int(60) * MINUTE_MS
			browse({ visitorId, userId: "", groupId: "", host: MARKETING_HOST }, at, rng.pick(SOURCES), [
				{ afterMs: 0, page: rng.chance(0.3) ? "/blog/launch" : "/" },
				...(rng.chance(0.4) ? [{ afterMs: 2 * MINUTE_MS, page: "/pricing" }] : []),
				...(rng.chance(0.25) ? [{ afterMs: 3 * MINUTE_MS, page: "/docs/quickstart" }] : []),
			])
		},
	)

	return {
		startMs,
		endMs,
		accounts,
		users,
		events: Arr.sort(
			events,
			Order.mapInput(Order.Number, (row: WorldEvent) => row.atMs),
		),
		sessions,
	}
}

// Inserts

const quote = (value: string): string =>
	`'${Str.replaceAll("'", "\\'")(Str.replaceAll("\\", "\\\\")(value))}'`

/** `YYYY-MM-DD HH:MM:SS.mmm` in UTC. */
export const chTimestamp = (ms: number): string =>
	Str.replace("T", " ")(Str.slice(0, 23)(new Date(ms).toISOString()))

/** `YYYY-MM-DD HH:MM:SS`: how a tool's `start_time` and `end_time` are written. */
export const toolTime = (ms: number): string => Str.slice(0, 19)(chTimestamp(ms))
/** `YYYY-MM-DD`: how a question names a day. */
export const dayOf = (ms: number): string => Str.slice(0, 10)(chTimestamp(ms))

const mapLiteral = (attributes: Readonly<Record<string, string>>): string =>
	`map(${Arr.join(
		Arr.flatMap(Rec.toEntries(attributes), ([key, value]) => [quote(key), quote(value)]),
		", ",
	)})`

const INSERT_CHUNK = 1_000

/** The world as INSERT statements for `product_events` and `session_replays`, in order. */
export const worldInserts = (world: World, orgId: string): ReadonlyArray<string> => {
	const org = quote(orgId)
	return [
		...Arr.map(Arr.chunksOf(world.events, INSERT_CHUNK), (chunk) => {
			const rows = Arr.map(
				chunk,
				(row) =>
					`(${org}, ${quote(chTimestamp(row.atMs))}, ${quote(row.source)}, ${quote(row.sessionId)}, ${row.seq}, ${quote(row.visitorId)}, ${quote(row.userId)}, ${quote(row.groupId)}, ${quote(row.kind)}, ${quote(row.eventName)}, ${quote(row.host)}, ${quote(row.pagePath)}, ${mapLiteral(row.attributes)})`,
			)
			return `INSERT INTO product_events (OrgId, Timestamp, Source, SessionId, Seq, VisitorId, UserId, GroupId, Kind, EventName, Host, PagePath, Attributes) VALUES ${Arr.join(rows, ", ")}`
		}),
		...Arr.map(Arr.chunksOf(world.sessions, INSERT_CHUNK), (chunk) => {
			const rows = Arr.map(
				chunk,
				(row) =>
					`(${org}, ${quote(row.sessionId)}, ${quote(chTimestamp(row.startMs))}, 'ended', ${quote(row.userId)}, 1, ${quote(row.visitorId)}, ${quote(row.groupId)}, ${quote(row.referrerHost)}, ${quote(row.utmSource)}, ${quote(row.utmMedium)}, ${quote(row.utmCampaign)}, ${quote(row.country)}, ${quote(row.host)}, ${quote(row.deviceType)}, ${quote(row.browserName)})`,
			)
			return `INSERT INTO session_replays (OrgId, SessionId, StartTime, Status, UserId, Version, VisitorId, GroupId, ReferrerHost, UtmSource, UtmMedium, UtmCampaign, Country, Host, DeviceType, BrowserName) VALUES ${Arr.join(rows, ", ")}`
		}),
	]
}

// The reference: what the rows say, in plain TypeScript.

export interface Range {
	readonly fromMs: number
	readonly toMs: number
}

export type Predicate = (row: WorldEvent) => boolean

export const named =
	(eventName: string, attributes: Readonly<Record<string, string>> = {}): Predicate =>
	(row) =>
		row.eventName === eventName &&
		Arr.every(Rec.toEntries(attributes), ([key, value]) => row.attributes[key] === value)

export const viewed =
	(pagePath: string, host?: string): Predicate =>
	(row) =>
		row.kind === "navigation" && row.pagePath === pagePath && (host === undefined || row.host === host)

export const inRange =
	(range: Range): Predicate =>
	(row) =>
		row.atMs >= range.fromMs && row.atMs < range.toMs

export const rowsWhere = (world: World, ...predicates: ReadonlyArray<Predicate>): ReadonlyArray<WorldEvent> =>
	Arr.filter(world.events, (row) => Arr.every(predicates, (predicate) => predicate(row)))

/** Visitor to the user it became: a session that carries both ids links them. */
export const identityLinks = (world: World): ReadonlyMap<string, string> => {
	const links = new Map<string, string>()
	Arr.forEach(
		Arr.sort(
			world.sessions,
			Order.mapInput(Order.Number, (row: WorldSession) => row.startMs),
		),
		(row) => {
			if (row.visitorId !== "" && row.userId !== "" && !links.has(row.visitorId)) {
				links.set(row.visitorId, row.userId)
			}
		},
	)
	return links
}

export type KeyBy = "person" | "user" | "visitor" | "group" | "session"

/** The key a row counts under, `''` when it carries none. Mirrors the funnel's own rule. */
export const keyOf = (world: World, keyBy: KeyBy): ((row: WorldEvent) => string) => {
	const links = keyBy === "person" ? identityLinks(world) : undefined
	return (row) => {
		switch (keyBy) {
			case "user":
				return row.userId
			case "visitor":
				return row.visitorId
			case "group":
				return row.groupId
			case "session":
				return row.sessionId
			case "person":
				return row.userId !== "" ? row.userId : (links?.get(row.visitorId) ?? row.visitorId)
		}
	}
}

export const distinct = (
	rows: ReadonlyArray<WorldEvent>,
	key: (row: WorldEvent) => string,
): ReadonlySet<string> => new Set(Arr.filter(Arr.map(rows, key), (value) => value !== ""))

/**
 * How many keys reached each step in order, the whole chain inside `windowMs` of its step 1.
 * An attempt starts at any step-1 row and takes the first later row of each next step that is
 * still inside the window; a key's depth is its best attempt, as the funnel counts it.
 */
export const funnelCounts = (
	world: World,
	options: {
		readonly steps: ReadonlyArray<Predicate>
		readonly keyBy: KeyBy
		readonly windowMs: number
		readonly range: Range
	},
): ReadonlyArray<number> => {
	const key = keyOf(world, options.keyBy)
	const [first, ...later] = options.steps
	if (first === undefined) return []
	const byKey = Arr.groupBy(
		Arr.filter(rowsWhere(world, inRange(options.range)), (row) => key(row) !== ""),
		key,
	)
	const depthFrom = (rows: ReadonlyArray<WorldEvent>, start: WorldEvent): number => {
		let depth = 1
		let after = start.atMs
		for (const step of later) {
			const next = Arr.findFirst(
				rows,
				(row) => row.atMs > after && row.atMs <= start.atMs + options.windowMs && step(row),
			)
			if (next._tag === "None") break
			after = next.value.atMs
			depth += 1
		}
		return depth
	}
	const depths = Arr.map(Rec.values(byKey), (rows) =>
		Math.max(0, ...Arr.map(Arr.filter(rows, first), (start) => depthFrom(rows, start))),
	)
	return Arr.map(options.steps, (_, index) => Arr.filter(depths, (depth) => depth > index).length)
}

/** The whole weeks of the world as ranges, oldest first. */
export const weekRanges = (world: World): ReadonlyArray<Range> =>
	Arr.makeBy(WORLD_WEEKS, (week) => ({
		fromMs: world.startMs + week * WEEK_MS,
		toMs: world.startMs + (week + 1) * WEEK_MS,
	}))

/** The last `weeks` whole weeks of the world. */
export const lastWeeks = (world: World, weeks: number): Range => ({
	fromMs: world.endMs - weeks * WEEK_MS,
	toMs: world.endMs,
})
