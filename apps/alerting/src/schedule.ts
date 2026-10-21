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
 * A fire holds one outbound connection per lane while its hops run, so keep a
 * cron under the Workers limit of six simultaneous connections per invocation.
 */
export const ALERTING_SCHEDULE = {
	// `error` also runs fix verification, chained after it (see `./scheduled.ts`).
	// Under two periods, not one: the alert tick drains deliveries after it
	// evaluates, so a one-minute bound would starve the drain on a slow minute.
	// `supabase_logs` reads each opted-in project's last minute (Supabase allows 10 queries a minute).
	"* * * * *": { lanes: ["alert", "error", "escalation", "supabase_logs"], deadline: "110 seconds" },
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
	"*/15 * * * *": { lanes: ["digest"], deadline: "10 minutes" },
	"0 * * * *": { lanes: ["service_map_rollup", "supabase_discovery"], deadline: "15 minutes" },
} as const satisfies Record<string, CronSchedule>

export type AlertingCron = keyof typeof ALERTING_SCHEDULE
export type TickLane = (typeof ALERTING_SCHEDULE)[AlertingCron]["lanes"][number]

const isAlertingCron = (cron: string): cron is AlertingCron => Object.hasOwn(ALERTING_SCHEDULE, cron)

export const ALERTING_CRONS: ReadonlyArray<AlertingCron> =
	Object.keys(ALERTING_SCHEDULE).filter(isAlertingCron)

/** `cron`'s schedule, or `undefined` for a cron this Worker does not know. */
export const scheduleFor = (cron: string): CronSchedule | undefined =>
	isAlertingCron(cron) ? ALERTING_SCHEDULE[cron] : undefined

/** Whether `lane` is one of `cron`'s lanes. */
export const isLaneOf = (cron: string, lane: string): lane is TickLane =>
	scheduleFor(cron)?.lanes.includes(lane) ?? false
