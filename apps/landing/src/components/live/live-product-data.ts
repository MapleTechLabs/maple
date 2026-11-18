import { Array as Arr, Option } from "effect"

// An invented week of a SaaS signup flow, the same numbers as the dashboard's
// `/lab/product-analytics` fixtures, so the landing's funnel and paths agree with its screenshots.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export type FunnelStep = Readonly<{
	name: string
	value: number
	p50Ms?: number
	p90Ms?: number
	sinceStartP50Ms?: number
	sinceStartP90Ms?: number
	leavers?: ReadonlyArray<Readonly<{ name: string; count: number }>>
}>

export const FUNNEL: ReadonlyArray<FunnelStep> = [
	{ name: "signup_started", value: 1_206 },
	{
		name: "signup_completed",
		value: 742,
		p50Ms: 3 * MINUTE,
		p90Ms: 24 * MINUTE,
		sinceStartP50Ms: 3 * MINUTE,
		sinceStartP90Ms: 24 * MINUTE,
		leavers: [
			{ name: "docs_opened", count: 210 },
			{ name: "", count: 152 },
			{ name: "/pricing", count: 64 },
			{ name: "/", count: 38 },
		],
	},
	{
		name: "onboarding_connected",
		value: 388,
		p50Ms: 112 * MINUTE,
		p90Ms: 26 * HOUR,
		sinceStartP50Ms: 2 * HOUR,
		sinceStartP90Ms: 27 * HOUR,
		leavers: [
			{ name: "", count: 190 },
			{ name: "docs_opened", count: 96 },
			{ name: "query_run", count: 41 },
			{ name: "/pricing", count: 27 },
		],
	},
	{
		name: "plan_started",
		value: 61,
		p50Ms: 2 * DAY + 3 * HOUR,
		p90Ms: 6 * DAY,
		sinceStartP50Ms: 2 * DAY + 6 * HOUR,
		sinceStartP90Ms: 6 * DAY + 8 * HOUR,
		leavers: [
			{ name: "dashboard_created", count: 140 },
			{ name: "query_run", count: 88 },
			{ name: "", count: 61 },
			{ name: "docs_opened", count: 38 },
		],
	},
]

/** The step that loses the largest share of those who reached the step before it. */
export const biggestDrop = (
	steps: ReadonlyArray<FunnelStep>,
): Option.Option<Readonly<{ name: string; share: number }>> =>
	Arr.reduce(
		Arr.drop(steps, 1),
		Option.none<Readonly<{ name: string; share: number }>>(),
		(best, step, index) => {
			const previous = steps[index]?.value ?? 0
			if (previous <= 0) return best
			const share = 1 - step.value / previous
			return Option.isSome(best) && best.value.share >= share
				? best
				: Option.some({ name: step.name, share })
		},
	)

export type PathHop = Readonly<{ hop: number; fromNode: string; toNode: string; count: number }>

/** What people did after `signup_completed`. `""` is ended, `$other` the folded remainder. */
export const PATHS_ANCHOR = "signup_completed"

export const PATHS: ReadonlyArray<PathHop> = [
	{ hop: 1, fromNode: "signup_completed", toNode: "onboarding_viewed", count: 410 },
	{ hop: 1, fromNode: "signup_completed", toNode: "dashboard_viewed", count: 160 },
	{ hop: 1, fromNode: "signup_completed", toNode: "docs_opened", count: 92 },
	{ hop: 1, fromNode: "signup_completed", toNode: "$other", count: 50 },
	{ hop: 1, fromNode: "signup_completed", toNode: "", count: 30 },
	{ hop: 2, fromNode: "onboarding_viewed", toNode: "onboarding_connected", count: 290 },
	{ hop: 2, fromNode: "onboarding_viewed", toNode: "query_run", count: 60 },
	{ hop: 2, fromNode: "onboarding_viewed", toNode: "", count: 60 },
	{ hop: 2, fromNode: "dashboard_viewed", toNode: "query_run", count: 90 },
	{ hop: 2, fromNode: "dashboard_viewed", toNode: "/pricing", count: 40 },
	{ hop: 2, fromNode: "dashboard_viewed", toNode: "", count: 30 },
	{ hop: 2, fromNode: "docs_opened", toNode: "/pricing", count: 34 },
	{ hop: 2, fromNode: "docs_opened", toNode: "", count: 58 },
	{ hop: 2, fromNode: "$other", toNode: "$other", count: 50 },
	{ hop: 3, fromNode: "onboarding_connected", toNode: "dashboard_created", count: 170 },
	{ hop: 3, fromNode: "onboarding_connected", toNode: "alert_created", count: 64 },
	{ hop: 3, fromNode: "onboarding_connected", toNode: "", count: 56 },
	{ hop: 3, fromNode: "query_run", toNode: "dashboard_created", count: 40 },
	{ hop: 3, fromNode: "query_run", toNode: "query_run", count: 84 },
	{ hop: 3, fromNode: "query_run", toNode: "", count: 26 },
	{ hop: 3, fromNode: "/pricing", toNode: "alert_created", count: 32 },
	{ hop: 3, fromNode: "/pricing", toNode: "", count: 42 },
	{ hop: 3, fromNode: "$other", toNode: "", count: 50 },
]

/** People who reached the anchor: everything leaving it on the first hop. */
export const pathsTotal = Arr.reduce(
	Arr.filter(PATHS, (row) => row.hop === 1),
	0,
	(sum, row) => sum + row.count,
)
