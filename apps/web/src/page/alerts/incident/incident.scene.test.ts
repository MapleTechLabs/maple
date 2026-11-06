import { OrgId } from "@maple/domain"
import { AlertRulePreviewResponse } from "@maple/domain/http"
import { sloRuleName } from "@maple/domain/slo"
import { Result, Schema, Array as Arr } from "effect"
import {
	click,
	Command,
	expect as expectView,
	expectOutMessage,
	given,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { CreateInvestigation, FetchIncidentActivity, SetIncidentAcknowledged } from "./command"
import {
	encodePublicId,
	PublicIdPrefixes,
	V2AlertIncident,
	V2AlertIncidentEvent,
} from "@maple/domain/http/v2"
import { describe, expect, test } from "vitest"
import * as Chart from "@maple/views/charts/chart"
import { requestKey } from "@maple/views/data/request-key"
import { isoMs } from "../shared/time"
import { MountChart } from "@maple/views/charts/chart-mounts"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { PageOutMessage, type PageContext } from "../../contract"
import { sloHref, slosTabHref } from "../shared/slo-commands"
import { checkoutSlo } from "../shared/slo-test-fixtures"
import { monitorHref, uptimeTabHref } from "../shared/uptime-commands"
import { httpMonitor, MONITOR_RULE, monitorId } from "../shared/uptime-test-monitors"
import { incidentRow, INCIDENT_ID, NOW, ORG, ruleRow, stateRow } from "../shared/test-rows"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

const route = (incidentId = INCIDENT_ID) => ({ _tag: "AlertIncident" as const, incidentId, search: {} })

const step = (model: Model, message: Message) => pageUpdate(model, message)

describe("alert incident", () => {
	test("entry reads the clock and loads the chart runtime; the incident's reads follow its row", () => {
		const entered = init(route(), context)
		expect(names(entered.commands)).toEqual(
			expect.arrayContaining(["ReadAlertIncidentClock", "LoadChartRuntime"]),
		)
		const clocked = step(entered.model, Message.ReadClock({ nowMs: NOW })).model
		const withIncident = step(clocked, Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow()] }))
		expect(names(withIncident.commands)).toEqual(
			expect.arrayContaining(["FetchAlertIncidentDeliveries", "FetchAlertIncidentInvestigation"]),
		)
		const withRule = step(withIncident.model, Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2)] }))
		expect(names(withRule.commands)).toEqual(
			expect.arrayContaining(["FetchAlertIncidentChecks", "FetchAlertIncidentPreview"]),
		)
		const again = step(withRule.model, Message.UpdatedRuleStates({ orgId: ORG, rows: [stateRow(2)] }))
		expect(again.commands ?? []).toHaveLength(0)
	})

	test("a SQL rule without a time bucket charts what the evaluator recorded", () => {
		const sql =
			"SELECT max(lag) AS value FROM metrics_gauge WHERE $__orgFilter AND $__timeFilter(TimeUnix)"
		const loaded = Arr.reduce(
			[
				Message.ReadClock({ nowMs: NOW }),
				Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow({ signal_type: "raw_query" })] }),
				Message.UpdatedRules({
					orgId: ORG,
					rows: [ruleRow(2, { signal_type: "raw_query", raw_query_sql: sql, reducer: "max" })],
				}),
			],
			init(route(), context).model,
			(model, message) => step(model, message).model,
		)
		const preview = Schema.decodeSync(AlertRulePreviewResponse)({
			bucketSeconds: 300,
			windowMinutes: 5,
			threshold: 800,
			thresholdUpper: null,
			thresholds: [
				{ severity: "critical", value: 800, upper: null, recoveryValue: null, destinationIds: [] },
			],
			comparator: "gt",
			truncatedToStart: null,
			series: [],
			wouldFire: [],
			seriesFailure: "not_time_grouped",
		})
		const answeredPreview = step(
			loaded,
			Message.CompletedFetchPreview({ key: loaded.preview.key ?? "", result: Result.succeed(preview) }),
		).model
		const bucket = (minutesAgo: number, observedValue: number) => ({
			bucket: new Date(NOW - minutesAgo * 60_000).toISOString(),
			groupKey: "all",
			totalCount: 5,
			breachedCount: observedValue > 800 ? 5 : 0,
			healthyCount: observedValue > 800 ? 0 : 5,
			skippedCount: 0,
			errorCount: 0,
			transitionCount: 0,
			observedValue,
			threshold: 800,
		})
		const answered = step(
			answeredPreview,
			Message.CompletedFetchChecks({
				key: answeredPreview.checks.key ?? "",
				result: Result.succeed({
					bucketSeconds: 300,
					totals: { total: 15, breached: 10, healthy: 5, skipped: 0, error: 0, transitions: 1 },
					points: [bucket(30, 400), bucket(20, 10_600), bucket(10, 10_600)],
				}),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(answered),
			themeResolved(),
			Mount.resolve(MountChart, Chart.Message.CompletedMountChart()),
			expectView(text("has no points in this window.", { exact: false })).toExist(),
			expectView(text(/returns one value for the whole range/)).toExist(),
			expectView(text("Preview query failed")).not.toExist(),
		)
	})

	test("another rule's live tick keeps the page as it was; its own rule's tick does not", () => {
		const loaded = Arr.reduce(
			[
				Message.ReadClock({ nowMs: NOW }),
				Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow()] }),
				Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2), ruleRow(3)] }),
				Message.UpdatedRuleStates({ orgId: ORG, rows: [stateRow(2), stateRow(3)] }),
			],
			init(route(), context).model,
			(model, message) => step(model, message).model,
		)
		const otherTicked = step(
			loaded,
			Message.UpdatedRuleStates({ orgId: ORG, rows: [stateRow(2), stateRow(3, { last_value: 99 })] }),
		)
		expect(otherTicked.model).toBe(loaded)
		const otherEdited = step(
			loaded,
			Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2), ruleRow(3, { name: "Renamed" })] }),
		)
		expect(otherEdited.model).toBe(loaded)
		const ownTicked = step(
			loaded,
			Message.UpdatedRuleStates({ orgId: ORG, rows: [stateRow(2, { last_value: 99 }), stateRow(3)] }),
		)
		expect(ownTicked.model).not.toBe(loaded)
	})

	test("an uptime incident asks for no rule preview and says what its signal is", () => {
		const entered = init(route(), context).model
		const uptimeIncident = incidentRow({ signal_type: "uptime", rule_name: "Checkout health" })
		const loaded = Arr.reduce(
			[
				Message.ReadClock({ nowMs: NOW }),
				Message.UpdatedIncidents({ orgId: ORG, rows: [uptimeIncident] }),
			],
			entered,
			(model, message) => step(model, message).model,
		)
		const withRule = step(
			loaded,
			Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2, { signal_type: "uptime" })] }),
		)
		expect(names(withRule.commands)).not.toContain("FetchAlertIncidentPreview")
		scene(
			{ update: pageUpdate, view },
			given(withRule.model),
			themeResolved(),
			expectView(text("resolves when one passes again", { exact: false })).toExist(),
		)
	})

	test("an SLO incident asks for no rule preview, offers no rule edit, and links its SLO once known", () => {
		const sloIncident = incidentRow({
			rule_name: "SLO burn: Checkout API",
			signal_type: "slo_burn_rate",
			comparator: "gte",
			threshold: 6,
			last_observed_value: 16.1,
			group_key: "__total__",
		})
		const loaded = Arr.reduce(
			[
				Message.ReadClock({ nowMs: NOW }),
				Message.UpdatedIncidents({ orgId: ORG, rows: [sloIncident] }),
			],
			init(route(), context).model,
			(model, message) => step(model, message).model,
		)
		const withRule = step(
			loaded,
			Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2, { signal_type: "slo_burn_rate" })] }),
		)
		expect(names(withRule.commands)).not.toContain("FetchAlertIncidentPreview")
		expect(names(withRule.commands)).not.toContain("FetchAlertIncidentChecks")
		expect(names(step(loaded, Message.ReadClock({ nowMs: NOW })).commands)).not.toContain(
			"FetchAlertIncidentSlos",
		)
		expect(withRule.model.slos.key).not.toBeNull()
		scene(
			{ update: pageUpdate, view },
			given(withRule.model),
			themeResolved(),
			expectView(role("heading", { name: "Checkout API is burning its error budget" })).toExist(),
			expectView(text(/__total__/u)).not.toExist(),
			expectView(role("link", { name: "Edit rule" })).not.toExist(),
			expectView(role("link", { name: "Open SLOs" })).toHaveAttr("href", slosTabHref()),
		)
		const slo = checkoutSlo({ alert_rule_id: sloIncident.rule_id })
		const linked = step(
			withRule.model,
			Message.CompletedFetchSlos({ key: withRule.model.slos.key ?? "", result: Result.succeed([slo]) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(linked),
			themeResolved(),
			expectView(role("link", { name: "Open SLO" })).toHaveAttr("href", sloHref(slo.id)),
		)
	})

	test("a resolved SLO incident opened at its tier factor and no longer reads a current burn", () => {
		const resolved = incidentRow({
			rule_name: sloRuleName("Checkout API"),
			signal_type: "slo_burn_rate",
			comparator: "gte",
			threshold: 14.4,
			last_observed_value: 0.3,
			group_key: "__total__",
			status: "resolved",
			resolved_at: new Date(NOW - 60_000).toISOString(),
		})
		const loaded = Arr.reduce(
			[
				Message.ReadClock({ nowMs: NOW }),
				Message.UpdatedIncidents({ orgId: ORG, rows: [resolved] }),
				Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2, { signal_type: "slo_burn_rate" })] }),
			],
			init(route(), context).model,
			(model, message) => step(model, message).model,
		)
		const withDeliveries = step(
			loaded,
			Message.CompletedFetchDeliveries({
				key: loaded.deliveries.key ?? "",
				result: Result.succeed([]),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(withDeliveries),
			themeResolved(),
			expectView(role("heading", { name: "Checkout API stopped burning its error budget" })).toExist(),
			expectView(text("SLO burning its error budget at 14.4x or more")).toExist(),
			expectView(text(/0\.3x/u)).not.toExist(),
			expectView(text(/now /u)).not.toExist(),
		)
	})

	test("an uptime incident links its monitor once known and keeps its rule's history, without a rule edit", () => {
		const uptimeIncident = incidentRow({
			rule_id: MONITOR_RULE,
			rule_name: "checkout-api",
			signal_type: "uptime",
			group_key: "__total__",
		})
		const loaded = Arr.reduce(
			[
				Message.ReadClock({ nowMs: NOW }),
				Message.UpdatedIncidents({ orgId: ORG, rows: [uptimeIncident] }),
			],
			init(route(), context).model,
			(model, message) => step(model, message).model,
		)
		const withRule = step(
			loaded,
			Message.UpdatedRules({
				orgId: ORG,
				rows: [ruleRow(7, { signal_type: "uptime", name: "checkout-api" })],
			}),
		)
		expect(withRule.model.monitors.key).not.toBeNull()
		scene(
			{ update: pageUpdate, view },
			given(withRule.model),
			themeResolved(),
			expectView(role("link", { name: "Open monitors" })).toHaveAttr("href", uptimeTabHref()),
			expectView(role("link", { name: "Edit rule" })).not.toExist(),
			expectView(text(/^Fired 1 time in 30d/u)).toExist(),
		)
		const monitor = httpMonitor()
		const linked = step(
			withRule.model,
			Message.CompletedFetchMonitors({
				key: withRule.model.monitors.key ?? "",
				result: Result.succeed([httpMonitor({ id: monitorId(5), alert_rule_id: null }), monitor]),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(linked),
			themeResolved(),
			expectView(role("link", { name: "Open monitor" })).toHaveAttr("href", monitorHref(monitor.id)),
		)
	})

	test("a failed delivery read is not refetched when the live rows change", () => {
		const entered = init(route(), context).model
		const loaded = Arr.reduce(
			[
				Message.ReadClock({ nowMs: NOW }),
				Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow()] }),
			],
			entered,
			(model, message) => step(model, message).model,
		)
		const failed = step(
			loaded,
			Message.CompletedFetchDeliveries({
				key: loaded.deliveries.key ?? "",
				result: Result.fail(toLoadFailure(new Error("x"))),
			}),
		).model
		const updated = step(failed, Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow()] }))
		expect(updated.commands ?? []).toHaveLength(0)
		scene(
			{ update: pageUpdate, view },
			given(updated.model),
			themeResolved(),
			expectView(
				text(
					"Couldn't load the whole history, so some notifications or acknowledgements are missing.",
				),
			).toExist(),
		)
	})

	test("a changed incident row re-reads the clock, so Open Xm and the preview window move on", () => {
		const loaded = Arr.reduce(
			[
				Message.ReadClock({ nowMs: NOW }),
				Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow()] }),
				Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2)] }),
			],
			init(route(), context).model,
			(model, message) => step(model, message).model,
		)
		const changed = step(
			loaded,
			Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow({ last_observed_value: 2100 })] }),
		)
		expect(names(changed.commands)).toContain("ReadAlertIncidentClock")
		const later = step(changed.model, Message.ReadClock({ nowMs: NOW + 10 * 60_000 + 30_000 }))
		expect(later.model.nowMs).toBe(NOW + 10 * 60_000)
		expect(names(later.commands)).toContain("FetchAlertIncidentPreview")
		scene(
			{ update: pageUpdate, view },
			given(later.model),
			themeResolved(),
			expectView(text(/^Open 2h ·/)).toExist(),
		)
	})

	test("an uptime incident's header names the monitor and never the ungrouped key", () => {
		const uptime = incidentRow({
			rule_name: "checkout-api",
			signal_type: "uptime",
			comparator: "gte",
			threshold: 1,
			last_observed_value: 1,
			group_key: "__total__",
		})
		const loaded = Arr.reduce(
			[Message.ReadClock({ nowMs: NOW }), Message.UpdatedIncidents({ orgId: ORG, rows: [uptime] })],
			init(route(), context).model,
			(model, message) => step(model, message).model,
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			themeResolved(),
			expectView(role("heading", { name: "checkout-api is down" })).toExist(),
			expectView(text(/__total__/u)).not.toExist(),
		)
	})

	test("an unknown incident says so and links back to alerts", () => {
		const model = Arr.reduce(
			[Message.ReadClock({ nowMs: NOW }), Message.UpdatedIncidents({ orgId: ORG, rows: [] })],
			init(route("missing"), context).model,
			(current, message) => step(current, message).model,
		)
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(text("Incident not found")).toExist(),
			expectView(role("link", { name: "Back to alerts" })).toHaveAttr("href", "/alerts"),
		)
	})

	test("Investigate opens one investigation and navigates to it", () => {
		const loaded = Arr.reduce(
			[
				Message.ReadClock({ nowMs: NOW }),
				Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow()] }),
				Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2)] }),
			],
			init(route(), context).model,
			(model, message) => step(model, message).model,
		)
		const answered = step(
			loaded,
			Message.CompletedFetchInvestigation({
				key: loaded.investigation.key ?? "",
				result: Result.succeed(null),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(answered),
			themeResolved(),
			click(role("button", { name: "Investigate" })),
			expectView(role("button", { name: "Investigate" })).toBeDisabled(),
			Command.resolve(
				CreateInvestigation,
				Message.CompletedCreateInvestigation({ result: Result.succeed("inv-1") }),
			),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({ url: "/investigations/inv-1", isReplace: false }),
			),
		)
		const started = step(answered, Message.ClickedInvestigate())
		expect(names(started.commands)).toEqual(["CreateAlertInvestigation"])
		expect(step(started.model, Message.ClickedInvestigate()).commands ?? []).toHaveLength(0)
		const done = step(
			started.model,
			Message.CompletedCreateInvestigation({ result: Result.succeed("inv-1") }),
		)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/investigations/inv-1", isReplace: false }),
		)
	})

	/** The API's answer for the page's incident: its `inc_` id decodes back to the row's id. */
	const ackedIncident = (acknowledgedAt: string | null) =>
		Schema.decodeSync(V2AlertIncident)({
			id: encodePublicId(PublicIdPrefixes.alertIncident, INCIDENT_ID),
			object: "alert_incident",
			rule_id: "alrt_gU26thvJECdQvu54Ad9jiz",
			rule_name: "x",
			group_key: null,
			signal_type: "error_rate",
			severity: "critical",
			peak_severity: null,
			status: "open",
			comparator: "gt",
			threshold: 1,
			threshold_upper: null,
			first_triggered_at: new Date(NOW).toISOString(),
			last_triggered_at: new Date(NOW).toISOString(),
			resolved_at: null,
			last_observed_value: null,
			last_sample_count: null,
			dedupe_key: "d",
			last_delivered_event_type: null,
			last_notified_at: null,
			hold_reason: null,
			held_since: null,
			acknowledged_at: acknowledgedAt,
			acknowledged_by: acknowledgedAt === null ? null : { user_id: "user_dana", name: "Dana Kim" },
			acknowledged_via: acknowledgedAt === null ? null : "web",
			error_issue_id: null,
		})

	const ackEvent = (type: "acknowledged" | "unacknowledged", at: string) =>
		Schema.decodeSync(V2AlertIncidentEvent)({
			id: encodePublicId(
				PublicIdPrefixes.event,
				`0199a003-0000-7000-8000-00000000000${type === "acknowledged" ? 2 : 3}`,
			),
			object: "alert_incident_event",
			incident_id: encodePublicId(PublicIdPrefixes.alertIncident, INCIDENT_ID),
			type,
			actor: { user_id: "user_dana", name: "Dana Kim" },
			source: "web",
			created_at: at,
		})

	const activityKey = (acknowledgedAt: string | null) =>
		requestKey(ORG, "alertIncidents.listEvents", {
			id: INCIDENT_ID,
			acknowledgedAt: acknowledgedAt === null ? null : isoMs(acknowledgedAt),
		})

	test("Acknowledge marks the open incident and shows who is on it; Unacknowledge takes it back", () => {
		const loaded = Arr.reduce(
			[
				Message.ReadClock({ nowMs: NOW }),
				Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow()] }),
			],
			init(route(), context).model,
			(model, message) => step(model, message).model,
		)
		const ackedAt = new Date(NOW - 5 * 60_000).toISOString()
		const unackedAt = new Date(NOW - 2 * 60_000).toISOString()
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			themeResolved(),
			click(role("button", { name: "Acknowledge" })),
			Command.resolve(
				SetIncidentAcknowledged,
				Message.CompletedSetAcknowledged({
					acknowledged: true,
					result: Result.succeed(ackedIncident(ackedAt)),
				}),
			),
			// The patched row's ack moved the history's key, so the history is read again and drawn.
			Command.resolve(
				FetchIncidentActivity,
				Message.CompletedFetchActivity({
					key: activityKey(ackedAt),
					result: Result.succeed([ackEvent("acknowledged", ackedAt)]),
				}),
			),
			expectView(text(/Acknowledged by Dana Kim at/)).toExist(),
			expectView(text("From the dashboard · reminders paused")).toExist(),
			click(role("button", { name: "Unacknowledge" })),
			Command.resolve(
				SetIncidentAcknowledged,
				Message.CompletedSetAcknowledged({
					acknowledged: false,
					result: Result.succeed(ackedIncident(null)),
				}),
			),
			Command.resolve(
				FetchIncidentActivity,
				Message.CompletedFetchActivity({
					key: activityKey(null),
					result: Result.succeed([
						ackEvent("acknowledged", ackedAt),
						ackEvent("unacknowledged", unackedAt),
					]),
				}),
			),
			expectView(text("Unacknowledged by Dana Kim")).toExist(),
			expectView(role("button", { name: "Acknowledge" })).toExist(),
			expectView(text(/Acknowledged by Dana Kim at/)).not.toExist(),
		)
		const clicked = step(loaded, Message.ClickedAcknowledge({ acknowledged: true }))
		// A second click while the request runs sends nothing.
		expect(
			step(clicked.model, Message.ClickedAcknowledge({ acknowledged: true })).commands ?? [],
		).toHaveLength(0)
		const done = step(
			clicked.model,
			Message.CompletedSetAcknowledged({
				acknowledged: true,
				result: Result.succeed(ackedIncident(ackedAt)),
			}),
		)
		// The sync then delivers the same acknowledgement: no second read of the history.
		const synced = step(
			done.model,
			Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow({ acknowledged_at: ackedAt })] }),
		)
		expect(names(synced.commands)).not.toContain("FetchAlertIncidentActivity")
		const failed = step(
			clicked.model,
			Message.CompletedSetAcknowledged({
				acknowledged: true,
				result: Result.fail(toLoadFailure(new Error("boom"))),
			}),
		)
		expect(failed.outMessage).toMatchObject({
			_tag: "RequestedToast",
			title: "Couldn't acknowledge the incident",
		})
		expect(failed.model.isUpdatingAcknowledgement).toBe(false)
	})

	test("a resolved incident offers no acknowledge button", () => {
		const loaded = Arr.reduce(
			[
				Message.ReadClock({ nowMs: NOW }),
				Message.UpdatedIncidents({
					orgId: ORG,
					rows: [
						incidentRow({
							status: "resolved",
							resolved_at: new Date(NOW - 60_000).toISOString(),
						}),
					],
				}),
			],
			init(route(), context).model,
			(model, message) => step(model, message).model,
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			themeResolved(),
			expectView(role("button", { name: "Acknowledge" })).not.toExist(),
		)
	})
})
