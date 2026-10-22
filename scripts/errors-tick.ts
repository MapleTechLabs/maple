/**
 * Fire the alerting Worker's minute cron once, on a local `bun dev` stack.
 *
 * That cron runs the errors tick (candidates -> issues, incidents, regressions)
 * with fix verification, and also the alert and escalation lanes
 * (`apps/alerting/src/schedule.ts`): alert rules evaluate and may notify too.
 * It is the way to see newly ingested exceptions become issues without waiting.
 *
 *   bun run errors:tick
 *   bun run errors:tick -- --url https://my-branch.alerting.localhost
 *
 * The Worker skips every cron off production unless MAPLE_ALERTING_ALLOW_NONPROD=1
 * is in the env `bun dev` was started with; the alerting log says so once.
 */
import { parseArgs } from "node:util"

const MINUTE_CRON = "* * * * *"

const { values } = parseArgs({
	options: {
		url: { type: "string" },
		cron: { type: "string", default: MINUTE_CRON },
	},
})

const base = (values.url ?? process.env.MAPLE_DEV_ALERTING_URL ?? "https://alerting.localhost").replace(
	/\/$/,
	"",
)
const cron = values.cron ?? MINUTE_CRON
const target = `${base}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(cron)}`

const started = Date.now()
const response = await fetch(target).catch((cause: unknown) => {
	console.error(`Could not reach ${base}: ${String(cause)}`)
	console.error("Is the stack up with alerting in it? `bun dev api web ingest alerting`")
	process.exit(1)
})
const body = (await response.text()).trim()

if (!response.ok) {
	console.error(`${response.status} from ${target}${body ? `\n${body}` : ""}`)
	process.exit(1)
}

console.log(`Fired "${cron}" on ${base} in ${Date.now() - started}ms${body ? ` (${body})` : ""}.`)
console.log("Issues appear once the tick finishes; the alerting log shows the run.")
console.log("Nothing happened? Start `bun dev` with MAPLE_ALERTING_ALLOW_NONPROD=1.")
