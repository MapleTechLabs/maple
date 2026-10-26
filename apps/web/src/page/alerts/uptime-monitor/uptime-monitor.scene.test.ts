import { OrgId } from "@maple/domain"
import { UptimeMonitorPublicId } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import {
	displayValue,
	expect as expectView,
	given,
	Mount,
	role,
	scene,
	selector,
	text,
	within,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "../../../charts/theme-colors"
import { PageOutMessage, type PageContext } from "../../contract"
import { destinationRow, incidentRow, NOW, ORG } from "../shared/test-rows"
import type { UptimeMonitor } from "../shared/uptime-derive"
import { downMonitor, heartbeatMonitor, httpMonitor, MONITOR_RULE } from "../shared/uptime-test-monitors"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const publicId = Schema.encodeSync(UptimeMonitorPublicId)
const incidentAlert = selector('[data-slot="alert"]')
const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

const opened = (monitor: UptimeMonitor, extra: ReadonlyArray<Message> = []): Model => {
	const entered = init(
		{ _tag: "AlertsUptimeMonitor", monitorId: publicId(monitor.id), search: {} },
		context,
	).model
	return [
		Message.ReadClock({ nowMs: NOW }),
		Message.CompletedFetchSession({ orgId: ORG, isAdmin: true }),
		Message.CompletedFetchMonitor({ key: entered.monitor.key ?? "", result: Result.succeed(monitor) }),
		...extra,
	].reduce((model, message) => pageUpdate(model, message).model, entered)
}

describe("uptime monitor page", () => {
	test("entry reads the monitor by the id in the URL", () => {
		const entry = init(
			{ _tag: "AlertsUptimeMonitor", monitorId: publicId(httpMonitor().id), search: {} },
			context,
		)
		expect(names(entry.commands)).toContain("FetchUptimeMonitor")
	})

	test("an id that is not a monitor's reads nothing and says so", () => {
		const entry = init({ _tag: "AlertsUptimeMonitor", monitorId: "nope", search: {} }, context)
		expect(names(entry.commands)).not.toContain("FetchUptimeMonitor")
		scene(
			{ update: pageUpdate, view },
			given(entry.model),
			themeResolved(),
			expectView(text("Monitor not found")).toExist(),
		)
	})

	test("a down monitor leads with what it returns and links the failing trace and its rule's open incident", () => {
		const monitor = downMonitor()
		const incident = incidentRow({
			signal_type: "uptime",
			rule_id: MONITOR_RULE,
			rule_name: "Renamed since",
			group_key: "__total__",
		})
		const otherRule = incidentRow({
			id: "0199a003-0000-7000-8000-000000000009",
			signal_type: "uptime",
			rule_name: monitor.name,
		})
		scene(
			{ update: pageUpdate, view },
			given(opened(monitor, [Message.UpdatedIncidents({ orgId: ORG, rows: [otherRule, incident] })])),
			themeResolved(),
			// All of it sits in one alert block, not a panel that collapses in the page column.
			expectView(within(incidentAlert, text("Returning 503 since 11:54:00 AM"))).toExist(),
			expectView(within(incidentAlert, text("Service Unavailable"))).toExist(),
			expectView(within(incidentAlert, role("link", { name: "Open failing trace" }))).toHaveAttr(
				"href",
				"/traces/7f3c000000000000000000000000a91e",
			),
			expectView(within(incidentAlert, role("link", { name: "Open incident" }))).toHaveAttr(
				"href",
				`/alerts/incidents/${incident.id}`,
			),
		)
	})

	test("an up monitor has no incident block, and the setup names its destinations", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				opened(httpMonitor(), [
					Message.UpdatedDestinations({
						orgId: ORG,
						rows: [destinationRow({ name: "PagerDuty oncall" })],
					}),
				]),
			),
			themeResolved(),
			expectView(incidentAlert).not.toExist(),
			expectView(text("Open failing trace")).not.toExist(),
			expectView(text("PagerDuty oncall")).toExist(),
			expectView(role("link", { name: "View all checks in Traces" })).toHaveAttr(
				"href",
				"/traces?services=%5B%22maple-uptime%22%5D",
			),
		)
	})

	test("a probed monitor reads its last 24 hours of checks once it loads; a heartbeat reads none", () => {
		const loadedAs = (monitor: UptimeMonitor) => {
			const entered = init(
				{ _tag: "AlertsUptimeMonitor", monitorId: publicId(monitor.id), search: {} },
				context,
			).model
			return pageUpdate(
				entered,
				Message.CompletedFetchMonitor({
					key: entered.monitor.key ?? "",
					result: Result.succeed(monitor),
				}),
			)
		}
		const http = loadedAs(httpMonitor())
		expect(names(http.commands)).toEqual(["FetchUptimeCheckStats"])
		expect(http.model.window).toBe("24h")
		expect(names(loadedAs(heartbeatMonitor()).commands)).toEqual([])
	})

	test("picking another window reads it; picking the same one again reads nothing", () => {
		const picked = pageUpdate(opened(httpMonitor()), Message.PickedWindow({ window: "7d" }))
		expect(names(picked.commands)).toEqual(["FetchUptimeCheckStats"])
		expect(names(pageUpdate(picked.model, Message.PickedWindow({ window: "7d" })).commands)).toEqual([])
	})

	test("the figures read the window's checks: uptime, how many failed, and P50, P95 and P99", () => {
		const model = opened(httpMonitor())
		const withStats = pageUpdate(
			model,
			Message.CompletedFetchStats({
				key: model.stats.key ?? "",
				result: Result.succeed({
					points: [],
					checks: 96,
					failures: 2,
					p50Ms: 121,
					p95Ms: 310,
					p99Ms: 884,
				}),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(withStats),
			themeResolved(),
			expectView(text("97.92%")).toExist(),
			expectView(text("96 checks, 2 failed")).toExist(),
			expectView(text("121 ms")).toExist(),
			expectView(text("310 ms")).toExist(),
			expectView(text("884 ms")).toExist(),
		)
	})

	test("before destinations sync, the setup counts them instead of calling them unavailable", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened(httpMonitor())),
			themeResolved(),
			expectView(text("1 destination")).toExist(),
			expectView(text(/Unavailable destination/u)).not.toExist(),
		)
	})

	test("the last check shows the status code, with the error on its own line", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened(downMonitor())),
			themeResolved(),
			expectView(text("503")).toExist(),
			expectView(text("503 Service Unavailable")).not.toExist(),
			expectView(text("2 failed checks in a row")).toExist(),
		)
	})

	test("a heartbeat has no response time and expects its schedule and grace", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened(heartbeatMonitor())),
			themeResolved(),
			expectView(text("Response time")).not.toExist(),
			expectView(text("every 1d, 30m grace")).toExist(),
		)
	})

	test("a heartbeat shows its ping URL, the failure variant, and no Check now", () => {
		const monitor = heartbeatMonitor()
		scene(
			{ update: pageUpdate, view },
			given(opened(monitor)),
			themeResolved(),
			expectView(displayValue("https://ingest.maple.dev/uptime/hb/abc123")).toExist(),
			expectView(
				displayValue("curl -fsS -m 10 --retry 3 https://ingest.maple.dev/uptime/hb/abc123/fail"),
			).toExist(),
			expectView(role("button", { name: "Check now" })).not.toExist(),
		)
	})

	test("Check now runs the saved config once and toasts the first failed assertion", () => {
		const checking = pageUpdate(opened(httpMonitor()), Message.ClickedCheckNow())
		expect(names(checking.commands)).toEqual(["CheckUptimeMonitorNow"])
		const done = pageUpdate(
			checking.model,
			Message.CompletedCheckNow({
				result: Result.succeed({
					object: "uptime_monitor.test_result",
					ok: false,
					status_code: 500,
					duration_ms: 120,
					failed_assertion: "Status code 500 is not 2xx",
					error: null,
					headers: {},
					body_prefix: null,
					body_truncated: false,
				}),
			}),
		)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "error",
				title: "Check failed",
				description: "Status code 500 is not 2xx",
			}),
		)
	})

	test("Pause sends the PATCH and re-reads the monitor when it lands", () => {
		const monitor = httpMonitor()
		scene(
			{ update: pageUpdate, view },
			given(opened(monitor)),
			themeResolved(),
			expectView(role("button", { name: "Pause" })).toExist(),
		)
		const pausing = pageUpdate(opened(monitor), Message.ClickedToggle())
		expect(names(pausing.commands)).toEqual(["ToggleUptimeMonitorEnabled"])
		const done = pageUpdate(
			pausing.model,
			Message.CompletedToggle({ result: Result.succeed({ ...monitor, enabled: false }) }),
		)
		expect(names(done.commands)).toEqual(["FetchUptimeMonitor"])
	})
})
