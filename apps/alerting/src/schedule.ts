import { Array as Arr, Record as Rec } from "effect"
/**
 * The alerting schedule: each cron fans out to independent lanes, and each lane
 * runs as its own placed invocation (`./tick-dispatch.ts`) with its own Postgres
 * pool, outbound slots and CPU budget. Kept free of the tick graph so the Worker
 * shell can read it at startup without importing `./scheduled`.
 */
interface CronSchedule {
	readonly lanes: ReadonlyArray<string>
	/**
	 * Wall-clock bound on one lane. A lane past it is interrupted and its pool
	 * closed; claims, leases and cursors leave the rest for the next fire.
	 */
	readonly deadline: `${number} ${"seconds" | "minutes"}`
}

/**
 * A fire holds one outbound connection per lane while its hops run, so a cron
 * keeps within the Workers limit of six per invocation (`scheduled.test.ts` checks).
 */
export const ALERTING_SCHEDULE = {
	// `error` also runs fix verification, chained after it (see `./scheduled.ts`).
	// Under two periods, not one: the alert tick drains deliveries after it
	// evaluates, so a one-minute bound would starve the drain on a slow minute.
	// `supabase_logs` reads each opted-in project's last minute (Supabase allows 10 queries a minute).
	// `alert_long_query` runs the raw SQL rules allowed a longer query (see `alertSchedulerLaneOf`).
	"* * * * *": {
		lanes: ["alert", "alert_long_query", "error", "escalation", "supabase_logs"],
		deadline: "110 seconds",
	},
	"*/5 * * * *": {
		lanes: [
			"anomaly",
			"cloudflare_analytics",
			"gcp_metrics",
			"planetscale",
			"railway_metrics",
			"pr_review_post_merge",
		],
		deadline: "270 seconds",
	},
	// Offset by two minutes: `*/5` is at the six-lane limit, and a fire of its own keeps the
	// Vercel poller off the Railway and Cloudflare pollers' minute.
	"2-59/5 * * * *": { lanes: ["vercel"], deadline: "270 seconds" },
	// `supabase_insights` reads top queries every tick and advisors hourly (it tracks the hour itself).
	// `maintenance_windows` writes the next 48 hours of maintenance occurrences as silences.
	// `search_console` imports Google Search Console days; a property re-imports its head every 6 hours
	// and walks its backfill one chunk per tick, so 15 minutes moves history without a minute cron.
	"*/15 * * * *": {
		lanes: ["digest", "supabase_insights", "maintenance_windows", "search_console"],
		deadline: "10 minutes",
	},
	// `secret_reseal` moves stored credentials onto the current key (docs/secret-encryption.md).
	"0 * * * *": {
		lanes: ["service_map_rollup", "supabase_discovery", "aws_connections", "secret_reseal"],
		deadline: "15 minutes",
	},
} as const satisfies Record<string, CronSchedule>

export type AlertingCron = keyof typeof ALERTING_SCHEDULE
export type TickLane = (typeof ALERTING_SCHEDULE)[AlertingCron]["lanes"][number]

const isAlertingCron = (cron: string): cron is AlertingCron =>
	Rec.has<string, unknown>(ALERTING_SCHEDULE, cron)

export const ALERTING_CRONS: ReadonlyArray<AlertingCron> = Arr.filter(
	Rec.keys(ALERTING_SCHEDULE),
	isAlertingCron,
)

/** `cron`'s schedule, or `undefined` for a cron this Worker does not know. */
export const scheduleFor = (cron: string): CronSchedule | undefined =>
	isAlertingCron(cron) ? ALERTING_SCHEDULE[cron] : undefined

export const isLaneOf = (cron: string, lane: string): lane is TickLane =>
	scheduleFor(cron)?.lanes.includes(lane) ?? false
