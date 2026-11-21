/**
 * Configuration tasks: one request to change how the org is set up, graded on the change the
 * agent proposes. In chat a change is approval-gated, so the proposal is the call.
 *
 * `control` tasks are changes the tools already covered when the suite was written; `gap` tasks
 * are ones they did not, so a run on an older catalog scores them zero and shows what the agent
 * does instead. Negative tasks ask a question, or leave out which thing, and must change nothing.
 * Every task runs in the org of `world.ts`. All start as `capability`.
 */
import type { ToolTask } from "../tools/tasks"
import { call, calls, never, type Check } from "../targets"
import { CONFIG_WORLD } from "./world"

const W = CONFIG_WORLD

const task = (id: string, tags: ReadonlyArray<string>, input: string, ...expect: ReadonlyArray<Check>) =>
	({
		id,
		tier: "capability",
		tags: ["config", ...tags],
		input,
		expect,
		// A change usually needs a lookup first (the rule's id, the destination's), then the proposal.
		maxToolCalls: 8,
	}) satisfies ToolTask

/** Every tool that changes alerting, for the tasks that only ask about it. */
const ALERT_WRITES = [
	"create_alert_rule",
	"update_alert_rule",
	"delete_alert_rule",
	"manage_alert_destination",
	"manage_alert_silence",
	"manage_maintenance_window",
] as const

export const CONFIG_TASKS: ReadonlyArray<ToolTask> = [
	// Controls: changes the catalog already covered.
	task(
		"alert-on-error-rate",
		["control", "alerts"],
		`Alert us on ${W.destination} when the subscriptions-api error rate goes above 5%.`,
		calls(call("create_alert_rule", { services: "subscriptions-api" })),
	),
	task(
		"route-rule-to-destination",
		["control", "alerts"],
		`Also send the "${W.rule}" alert to ${W.unusedDestination}.`,
		calls(
			call("update_alert_rule", { add_destination_ids: { present: true } }),
			call("update_alert_rule", { destination_ids: { present: true } }),
		),
	),
	task(
		"disable-rule",
		["control", "alerts"],
		`Turn off the "${W.rule}" alert for now, we'll want it back next week.`,
		// A silence or a one-off window over the rule turns it off and brings it back, as asked.
		calls(
			call("update_alert_rule", { enabled: false }),
			call("manage_alert_silence", { action: "create" }),
			call("manage_maintenance_window", { action: "create" }),
		),
		never("delete_alert_rule"),
	),
	task(
		"silence-for-deploy",
		["control", "alerts"],
		"We're deploying subscriptions-api for the next 2 hours. Mute its alerts until we're done.",
		calls(
			call("manage_alert_silence", { action: "create" }),
			call("manage_maintenance_window", { action: "create" }),
		),
	),
	task(
		"weekly-window",
		["control", "alerts"],
		"Every Sunday from 02:00 to 04:00 UTC we patch the database. Don't page anyone for subscriptions-api alerts during that.",
		calls(
			call("manage_maintenance_window", {
				action: "create",
				schedule_type: "weekly",
				days: "sun",
				start_time_of_day: "02:00",
				duration_minutes: 120,
			}),
		),
	),
	task(
		"extend-silence",
		["control", "alerts"],
		"The load test is running long. Keep checkout silenced for another hour after the silence was due to end.",
		// A silence is not edited: a second one over the extra hour holds the same notifications back.
		calls(call("manage_alert_silence", { action: "create" })),
	),
	task(
		"end-silence",
		["control", "alerts"],
		"The load test on checkout is done. Lift the silence so alerts go out again.",
		calls(call("manage_alert_silence", { action: "end" })),
	),
	task(
		"availability-slo",
		["control", "slos"],
		"Set a 99.9% availability SLO on checkout.",
		calls(
			call("manage_slo", {
				action: "create",
				service: "checkout",
				sli: "availability",
				target_percent: 99.9,
			}),
		),
	),
	task(
		"uptime-check",
		["control", "uptime"],
		`Check https://example.com/health every minute and tell ${W.destination} when it's down.`,
		calls(call("manage_uptime_monitor", { action: "create", url: { includes: "example.com/health" } })),
	),
	task(
		"drop-noise",
		["control", "ingest"],
		"Stop storing spans for the /ready route. They're just noise and we pay for them.",
		// A preview first is what the tool recommends, but only the proposed rule is the change.
		calls(
			call("manage_ingest_rule", {
				action: "create",
				conditions: { includes: "/ready" },
				rule_action: { includes: "drop" },
			}),
		),
	),
	task(
		"disable-ingest-rule",
		["control", "ingest"],
		`Turn off the "${W.dropRule}" rule, we need those spans back for a few days.`,
		calls(call("manage_ingest_rule", { action: "update", enabled: false })),
	),
	task(
		"scrape-endpoint",
		["control", "ingest"],
		"Start scraping https://metrics.example.com/metrics for the checkout service.",
		calls(call("manage_scrape_target", { action: "create", url: { includes: "metrics.example.com" } })),
	),
	task(
		"service-dashboard",
		["control", "dashboards"],
		"Create a service health dashboard for checkout.",
		calls(call("create_dashboard")),
	),
	task(
		"rename-dashboard",
		["control", "dashboards"],
		`Rename the "${W.staleDashboard}" dashboard to Archive.`,
		calls(call("update_dashboard", { name: "Archive" })),
	),
	task(
		"error-policy",
		["control", "errors"],
		"Stop notifying us when an error issue regresses. Brand new ones should still notify.",
		calls(call("update_error_notification_policy", { notify_on_regression: false })),
	),
	task(
		"status-page",
		["control", "status-pages"],
		"Create a status page called Acme Status.",
		calls(call("manage_status_page", { action: "create" })),
	),

	// Gaps: changes that had no tool.
	task(
		"test-destination",
		["gap", "destinations"],
		`Send a test notification to ${W.destination} so I can see that it arrives.`,
		calls(call("manage_alert_destination", { action: "test" })),
	),
	task(
		"disable-destination",
		["gap", "destinations"],
		`Stop sending anything to ${W.unusedDestination}, but keep it around in case we need it again.`,
		calls(call("manage_alert_destination", { action: "update", enabled: false })),
	),
	task(
		"rename-destination",
		["gap", "destinations"],
		`Rename the ${W.destination} destination to ops-primary.`,
		calls(call("manage_alert_destination", { action: "update", name: "ops-primary" })),
	),
	task(
		"delete-destination",
		["gap", "destinations"],
		`Nothing uses ${W.unusedDestination} anymore. Delete it.`,
		calls(call("manage_alert_destination", { action: "delete" })),
	),
	task(
		"email-me",
		["gap", "destinations"],
		"I want an email when one of our alerts fires. Set that up as a destination for me.",
		calls(call("manage_alert_destination", { action: "create", type: "email" })),
	),
	task(
		"pause-source",
		["gap", "sources"],
		`Pause the ${W.source} source while we fix its collector config.`,
		calls(call("manage_ingest_source", { action: "pause" })),
	),
	task(
		"pause-source-until",
		["gap", "sources"],
		`Stop accepting data from ${W.otherSource} for the next 24 hours, then let it back in on its own.`,
		calls(call("manage_ingest_source", { action: "pause", resume_at: { present: true } })),
	),
	task(
		"resume-source",
		["gap", "sources"],
		`${W.pausedSource} is fixed. Let its data in again.`,
		calls(call("manage_ingest_source", { action: "resume" })),
	),
	task(
		"rename-source",
		["gap", "sources"],
		`Rename the ${W.source} source to staging-otel.`,
		calls(call("manage_ingest_source", { action: "update", name: "staging-otel" })),
	),
	task(
		"delete-source",
		["gap", "sources"],
		`We decommissioned ${W.otherSource}. Remove its source so the token stops working.`,
		calls(call("manage_ingest_source", { action: "delete" })),
	),
	task(
		"lengthen-window",
		["gap", "alerts"],
		`Make the "${W.window}" maintenance window two hours long instead of one.`,
		calls(call("manage_maintenance_window", { action: "update", duration_minutes: 120 })),
	),
	task(
		"move-window",
		["gap", "alerts"],
		`The release train moved to Fridays. Change the "${W.window}" maintenance window to match.`,
		calls(call("manage_maintenance_window", { action: "update", days: "fri" })),
	),
	task(
		"delete-dashboard",
		["gap", "dashboards"],
		`Delete the "${W.staleDashboard}" dashboard, nobody looks at it.`,
		calls(call("delete_dashboard")),
	),

	// Negative: a question, or a change with no named target, changes nothing.
	task(
		"which-destinations",
		["negative", "destinations"],
		`Where does the "${W.rule}" alert send its notifications?`,
		calls(call("get_alert_rule"), call("list_alert_rules"), call("list_alert_destinations")),
		never(...ALERT_WRITES),
	),
	task(
		"ambiguous-destination-delete",
		["negative", "destinations"],
		"Delete the alert destination.",
		// Two exist. Listing them to ask which is right; deleting a guess is not.
		never("manage_alert_destination", "delete_alert_rule"),
	),
	task(
		"source-status",
		["negative", "sources"],
		`Is the ${W.source} source still sending data?`,
		calls(call("list_ingest_sources")),
		never("manage_ingest_source"),
	),
	task(
		"window-question",
		["negative", "alerts"],
		`When does the "${W.window}" maintenance window run?`,
		calls(call("list_maintenance_windows")),
		never(...ALERT_WRITES),
	),
]
