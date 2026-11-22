/**
 * Product questions about the Acme world, each with the answer the rows give.
 *
 * One list, two runners. `golden.test.ts` runs a scenario's `golden` calls with no model and
 * checks that every fact is on the page the model would read: the tools can answer it, in that
 * many calls. `product.eval.ts` gives a model only the question and grades its answer on the same
 * facts. A scenario with no `golden` has no direct tool path yet; the eval still asks it.
 */
import { Array as Arr, Option, Order, Record as Rec, String as Str } from "effect"
import { stringifyJson } from "../../mcp/lib/json"
import type { EvalTask } from "../runner"
import { answerDuration, answerMentions, answerNumber, type Check } from "../targets"
import {
	APP_HOST,
	DAY_MS,
	dayOf,
	distinct,
	funnelCounts,
	HOUR_MS,
	inRange,
	lastWeeks,
	MARKETING_HOST,
	named,
	type Predicate,
	type Range,
	rowsWhere,
	toolTime,
	viewed,
	WEEK_MS,
	weekRanges,
	type World,
	type WorldEvent,
} from "./world"

export interface GoldenCall {
	readonly tool: string
	readonly args: Readonly<Record<string, unknown>>
}

export interface Scenario extends EvalTask {
	/** As a product person would ask it: no tool or parameter names. */
	readonly question: string
	/** What a right answer states. */
	readonly facts: ReadonlyArray<Check>
	/** The shortest tool path that shows every fact. Absent until the tools have one. */
	readonly golden?: ReadonlyArray<GoldenCall>
	/** Tool results after which the turn is stopped. */
	readonly maxToolCalls: number
}

/** "between 2026-10-26 and 2026-11-22 (UTC, both days included)". */
const span = (range: Range): string =>
	`between ${dayOf(range.fromMs)} and ${dayOf(range.toMs - DAY_MS)} (UTC, both days included)`

const window = (range: Range) => ({ start_time: toolTime(range.fromMs), end_time: toolTime(range.toMs) })

const onHost =
	(host: string): Predicate =>
	(row) =>
		row.host === host

const userOf = (row: WorldEvent): string => row.userId
const visitorOf = (row: WorldEvent): string => row.visitorId
const groupOf = (row: WorldEvent): string => row.groupId

/** The most common value and how many keys carry it; ties go to the value that sorts first. */
const top = (counts: ReadonlyMap<string, number>): readonly [string, number] =>
	Arr.sort(
		[...counts],
		Order.combine(
			Order.mapInput(Order.flip(Order.Number), (entry: readonly [string, number]) => entry[1]),
			Order.mapInput(Order.String, (entry: readonly [string, number]) => entry[0]),
		),
	)[0] ?? ["", 0]

const tally = (values: ReadonlyArray<string>): ReadonlyMap<string, number> => {
	const counts = new Map<string, number>()
	Arr.forEach(values, (value) => counts.set(value, (counts.get(value) ?? 0) + 1))
	return counts
}

const median = (values: ReadonlyArray<number>): number => {
	const sorted = Arr.sort(values, Order.Number)
	const mid = (sorted.length - 1) / 2
	return ((sorted[Math.floor(mid)] ?? 0) + (sorted[Math.ceil(mid)] ?? 0)) / 2
}

export const productScenarios = (world: World): ReadonlyArray<Scenario> => {
	const fourWeeks = lastWeeks(world, 4)
	const threeWeeks = lastWeeks(world, 3)
	const twoWeeks = lastWeeks(world, 2)
	const lastWeek = lastWeeks(world, 1)
	const weekBefore = { fromMs: lastWeek.fromMs - WEEK_MS, toMs: lastWeek.fromMs }
	const whole = { fromMs: world.startMs, toMs: world.endMs }
	const sessionOf = new Map(Arr.map(world.sessions, (row) => [row.sessionId, row]))

	const scenario = (
		id: string,
		tags: ReadonlyArray<string>,
		question: string,
		facts: ReadonlyArray<Check>,
		golden?: ReadonlyArray<GoldenCall>,
	): Scenario => ({
		id,
		tier: "capability",
		tags,
		question,
		facts,
		...(golden === undefined ? undefined : { golden }),
		maxToolCalls: 6,
	})

	// 1. How often an event fired, and for how many users.
	const exports = rowsWhere(world, named("report_exported"), inRange(fourWeeks))

	// 2. Weekly active users of the app.
	const activeUsers = (range: Range) =>
		distinct(rowsWhere(world, onHost(APP_HOST), inRange(range)), userOf).size

	// 3. Sign-up to workspace to project, per user.
	const onboarding = funnelCounts(world, {
		steps: [named("signup_completed"), named("workspace_created"), named("project_created")],
		keyBy: "user",
		windowMs: 7 * DAY_MS,
		range: fourWeeks,
	})

	// 4. An anonymous pricing view and the sign-up it led to are one person.
	const pricingToSignup = funnelCounts(world, {
		steps: [viewed("/pricing", MARKETING_HOST), named("signup_completed")],
		keyBy: "person",
		windowMs: DAY_MS,
		range: threeWeeks,
	})

	// 5. The plan event carries the account and no user, so only accounts can be followed through.
	const paid = funnelCounts(world, {
		steps: [named("checkout_started"), named("plan_started")],
		keyBy: "group",
		windowMs: DAY_MS,
		range: fourWeeks,
	})

	// 6. Accounts, not users.
	const activeAccounts = distinct(rowsWhere(world, onHost(APP_HOST), inRange(lastWeek)), groupOf).size

	// 7. Visitors per acquisition source: a session's property, read through the event's session.
	const marketing = rowsWhere(world, onHost(MARKETING_HOST), inRange(threeWeeks))
	const visitorsBy = (dimension: "utmSource" | "country") => {
		const seen = new Map<string, Set<string>>()
		Arr.forEach(marketing, (row) => {
			const value = sessionOf.get(row.sessionId)?.[dimension] ?? ""
			seen.set(value, (seen.get(value) ?? new Set()).add(row.visitorId))
		})
		return new Map(Arr.map([...seen], ([value, visitors]) => [value, visitors.size]))
	}
	const [topSource, topSourceVisitors] = top(
		new Map(Arr.filter([...visitorsBy("utmSource")], ([source]) => source !== "")),
	)

	// 8. A page view narrowed by where the visitor is.
	const germanPricing = distinct(
		Arr.filter(
			rowsWhere(world, viewed("/pricing", MARKETING_HOST), inRange(threeWeeks)),
			(row) => sessionOf.get(row.sessionId)?.country === "DE",
		),
		visitorOf,
	).size

	// 9. What an event carries.
	const [topFormat] = top(tally(Arr.map(exports, (row) => row.attributes.format ?? "")))

	// 10. A sum over a numeric property.
	const plans = rowsWhere(world, named("plan_started"), inRange(whole))
	const revenue = Arr.reduce(plans, 0, (sum, row) => sum + Number(row.attributes.amount ?? 0))

	// 11. Retention of one sign-up week. The cohort is who signed up that week, whenever they return.
	const weeks = weekRanges(world)
	const cohortWeek = 1
	const cohort = Arr.filter(world.users, (user) => user.signupWeek === cohortWeek)
	const cohortIds = new Set(Arr.map(cohort, (user) => user.userId))
	const returnedIn = (week: number): number => {
		const range = weeks[week]
		return range === undefined
			? 0
			: distinct(
					Arr.filter(rowsWhere(world, inRange(range)), (row) => cohortIds.has(row.userId)),
					userOf,
				).size
	}
	const cohortStart = weeks[cohortWeek]?.fromMs ?? world.startMs

	// 12. What comes right after an event.
	const nextAfterWorkspace = tally(
		Arr.flatMap(rowsWhere(world, named("workspace_created"), inRange(fourWeeks)), (created) => {
			const next = Arr.findFirst(
				world.events,
				(row) =>
					row.userId === created.userId &&
					row.atMs > created.atMs &&
					row.atMs <= created.atMs + DAY_MS,
			)
			return Option.match(next, {
				onNone: () => [],
				onSome: (row) => [row.kind === "navigation" ? row.pagePath : row.eventName],
			})
		}),
	)
	const [topNext, topNextCount] = top(nextAfterWorkspace)

	// 13. How long a conversion takes.
	const signups = rowsWhere(world, named("signup_completed"), inRange(fourWeeks))
	const toProject = Arr.flatMap(signups, (signup) =>
		Option.match(
			Arr.findFirst(
				rowsWhere(world, named("project_created"), inRange(fourWeeks)),
				(row) =>
					row.userId === signup.userId &&
					row.atMs > signup.atMs &&
					row.atMs <= signup.atMs + 7 * DAY_MS,
			),
			{ onNone: () => [], onSome: (row) => [row.atMs - signup.atMs] },
		),
	)

	// 14. A step that is any page under a prefix.
	const dashboardThenExport = funnelCounts(world, {
		steps: [
			(row) => row.kind === "navigation" && Str.startsWith("/dashboards/")(row.pagePath),
			named("report_exported"),
		],
		keyBy: "user",
		windowMs: HOUR_MS,
		range: twoWeeks,
	})

	// 15. One user's recent history: the user whose last event is the latest export.
	const lastExport = exports[exports.length - 1]
	const timelineUser = lastExport?.userId ?? ""
	const timeline = Arr.takeRight(
		Arr.filter(world.events, (row) => row.userId === timelineUser),
		3,
	)
	const timelineDashboard = Arr.findFirst(timeline, (row) => Str.startsWith("/dashboards/")(row.pagePath))

	// 16. Did one thing and never another.
	const projectUsers = distinct(rowsWhere(world, named("project_created")), userOf)
	const workspaceOnly = Arr.filter(
		[...distinct(rowsWhere(world, named("workspace_created"), inRange(fourWeeks)), userOf)],
		(userId) => !projectUsers.has(userId),
	)

	// 17. A conversion with something excluded in between.
	const byUser = Arr.groupBy(
		Arr.filter(rowsWhere(world, inRange(fourWeeks)), (row) => row.userId !== ""),
		userOf,
	)
	const withoutInvite = Arr.filter(Rec.values(byUser), (rows) => {
		const created = Arr.findFirst(rows, named("workspace_created"))
		if (created._tag === "None") return false
		const project = Arr.findFirst(
			rows,
			(row) =>
				named("project_created")(row) &&
				row.atMs > created.value.atMs &&
				row.atMs <= created.value.atMs + 7 * DAY_MS,
		)
		if (project._tag === "None") return false
		return !Arr.some(
			rows,
			(row) =>
				named("invite_sent")(row) && row.atMs > created.value.atMs && row.atMs < project.value.atMs,
		)
	}).length

	// 18. The trap: nobody can be counted as a user on an event that carries none.
	const paidAccounts = distinct(rowsWhere(world, named("plan_started"), inRange(fourWeeks)), groupOf).size

	const funnel = (
		steps: ReadonlyArray<unknown>,
		range: Range,
		extra: Readonly<Record<string, unknown>> = {},
	) => ({
		tool: "query_funnel",
		args: { steps_json: stringifyJson(steps), ...window(range), ...extra },
	})

	return [
		scenario(
			"event-volume",
			["counts"],
			`How many times was a report exported (the report_exported event) ${span(fourWeeks)}, and by how many distinct users?`,
			[answerNumber("exports", exports.length), answerNumber("users", distinct(exports, userOf).size)],
			[
				{
					tool: "list_product_events",
					args: { search: "report_exported", kind: "custom", ...window(fourWeeks) },
				},
			],
		),
		scenario(
			"weekly-actives",
			["counts"],
			`How many distinct users were active in the app (host ${APP_HOST}) ${span(lastWeek)}, and how many in the week before (${dayOf(weekBefore.fromMs)} to ${dayOf(weekBefore.toMs - DAY_MS)})?`,
			[
				answerNumber("last week", activeUsers(lastWeek)),
				answerNumber("week before", activeUsers(weekBefore)),
			],
			Arr.map([lastWeek, weekBefore], (range) => ({
				tool: "query_data",
				args: {
					source: "product_events",
					kind: "breakdown",
					metric: "users",
					group_by: "host",
					host: APP_HOST,
					...window(range),
				},
			})),
		),
		scenario(
			"signup-funnel",
			["funnel"],
			`Of the users who signed up (signup_completed) ${span(fourWeeks)}, how many created a workspace (workspace_created) and how many then created a project (project_created), all within 7 days of signing up?`,
			[
				answerNumber("signed up", onboarding[0] ?? 0),
				answerNumber("created a workspace", onboarding[1] ?? 0),
				answerNumber("created a project", onboarding[2] ?? 0),
			],
			[
				funnel(
					[
						{ kind: "event", eventName: "signup_completed" },
						{ kind: "event", eventName: "workspace_created" },
						{ kind: "event", eventName: "project_created" },
					],
					fourWeeks,
					{ window_seconds: 7 * 86_400 },
				),
			],
		),
		scenario(
			"pricing-to-signup",
			["funnel", "identity"],
			`How many people viewed the pricing page (/pricing on ${MARKETING_HOST}) ${span(threeWeeks)}, and how many of them signed up (signup_completed) within a day of that view?`,
			[
				answerNumber("viewed pricing", pricingToSignup[0] ?? 0),
				answerNumber("signed up", pricingToSignup[1] ?? 0),
			],
			[
				funnel(
					[
						{ kind: "page", pagePath: "/pricing", host: MARKETING_HOST },
						{ kind: "event", eventName: "signup_completed" },
					],
					threeWeeks,
				),
			],
		),
		scenario(
			"paid-accounts",
			["funnel", "accounts"],
			`How many accounts started checkout (checkout_started) ${span(fourWeeks)}, and how many of those accounts went on to start a paid plan (plan_started) within a day?`,
			[
				answerNumber("accounts in checkout", paid[0] ?? 0),
				answerNumber("accounts that paid", paid[1] ?? 0),
			],
		),
		scenario(
			"active-accounts",
			["counts", "accounts"],
			`How many distinct accounts (not users) were active in the app (host ${APP_HOST}) ${span(lastWeek)}?`,
			[answerNumber("active accounts", activeAccounts)],
		),
		scenario(
			"visitors-by-source",
			["acquisition"],
			`Which utm_source brought the most visitors to ${MARKETING_HOST} ${span(threeWeeks)}, and how many distinct visitors came from it?`,
			[answerMentions(topSource), answerNumber(`visitors from ${topSource}`, topSourceVisitors)],
		),
		scenario(
			"pricing-by-country",
			["acquisition"],
			`How many distinct visitors from Germany viewed the pricing page (/pricing on ${MARKETING_HOST}) ${span(threeWeeks)}?`,
			[answerNumber("German pricing visitors", germanPricing)],
			[
				funnel([{ kind: "page", pagePath: "/pricing", host: MARKETING_HOST }], threeWeeks, {
					key_by: "visitor",
					country: "DE",
				}),
			],
		),
		scenario(
			"event-properties",
			["properties"],
			`Which properties does the report_exported event carry, and which value of its file format property was the most common ${span(fourWeeks)}?`,
			[answerMentions("format"), answerMentions(topFormat)],
		),
		scenario(
			"plan-revenue",
			["properties"],
			`What do the amount properties of all plan_started events ${span(whole)} add up to, and how many plan_started events were there?`,
			[answerNumber("total amount", revenue), answerNumber("plans started", plans.length)],
		),
		scenario(
			"signup-retention",
			["retention"],
			`Take the users who signed up (signup_completed) in the week starting ${dayOf(cohortStart)} (Monday, UTC). How many are there, how many of them did anything at all in the following week, and how many in the fourth week after their sign-up week?`,
			[
				answerNumber("cohort", cohort.length),
				answerNumber("returned the next week", returnedIn(cohortWeek + 1)),
				answerNumber("returned four weeks later", returnedIn(cohortWeek + 4)),
			],
		),
		scenario(
			"next-after-workspace",
			["paths"],
			`For workspaces created ${span(fourWeeks)}: what is the most common thing a user does right after workspace_created (their very next event or page view within a day), and how many users did that?`,
			[answerMentions(topNext), answerNumber(`users who went on to ${topNext}`, topNextCount)],
		),
		scenario(
			"time-to-project",
			["funnel", "timing"],
			`For users who signed up (signup_completed) ${span(fourWeeks)} and created a project (project_created) within 7 days: what was the median time from sign-up to the project?`,
			[answerDuration("median time to project", median(toProject), 0.1)],
		),
		scenario(
			"dashboard-then-export",
			["funnel", "pages"],
			`${span(twoWeeks)}: how many users viewed any dashboard page (a path that starts with /dashboards/), and how many of them exported a report (report_exported) within an hour of that view?`,
			[
				answerNumber("viewed a dashboard", dashboardThenExport[0] ?? 0),
				answerNumber("then exported", dashboardThenExport[1] ?? 0),
			],
		),
		scenario(
			"user-timeline",
			["users"],
			`What were the last three things user ${timelineUser} did in the product (events or page views), most recent first?`,
			[
				answerMentions("report_exported"),
				answerMentions(
					Option.match(timelineDashboard, {
						onNone: () => "/reports",
						onSome: (row) => row.pagePath,
					}),
				),
			],
		),
		scenario(
			"workspace-without-project",
			["cohorts", "users"],
			`How many users created a workspace (workspace_created) ${span(fourWeeks)} but have never created a project (project_created)?`,
			[answerNumber("users with a workspace and no project", workspaceOnly.length)],
		),
		scenario(
			"project-without-invite",
			["funnel", "cohorts"],
			`${span(fourWeeks)}: how many users went from workspace_created to project_created within 7 days without sending an invite (invite_sent) in between?`,
			[answerNumber("converted without an invite", withoutInvite)],
		),
		scenario(
			"paid-users-trap",
			["accounts", "identity"],
			`How many users started a paid plan (plan_started) ${span(fourWeeks)}?`,
			[answerMentions("account", "group"), answerNumber("accounts that started a plan", paidAccounts)],
		),
	]
}
