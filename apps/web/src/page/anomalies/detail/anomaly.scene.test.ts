import { OrgId } from "@maple/domain"
import { AnomalyIncidentId, AnomalyIncidentNotFoundError } from "@maple/domain/http"
import { encodePublicId, PublicIdPrefixes, V2AnomalyIncident, V2ErrorIssue } from "@maple/domain/http/v2"
import { errorIssueFromV2 } from "../../../lib/services/error-issues"
import { Option, Result, Schema } from "effect"
import {
	Command,
	expect as expectView,
	given,
	keydown,
	Mount,
	role,
	scene,
	text,
	type,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "../../../charts/theme-colors"
import { toLoadFailure } from "../../../data/load-failure"
import * as Dialog from "../../../ui/dialog"
import { type PageContext, PageOutMessage } from "../../contract"
import { SetIncidentIssue } from "./command"
import { incidentOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_parity"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const ID = Schema.decodeSync(AnomalyIncidentId)("0199a060-0000-7000-8000-000000000001")
const NOW = Date.UTC(2026, 9, 1, 12)
const themed = () => Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

const incident = Schema.decodeUnknownSync(V2AnomalyIncident)({
	id: encodePublicId(PublicIdPrefixes.anomalyIncident, ID),
	object: "anomaly_incident",
	detector_key: "latency_p95:payment-svc:production",
	signal_type: "latency_p95",
	service_name: "payment-svc",
	deployment_env: "production",
	fingerprint_hash: null,
	error_issue_id: null,
	status: "open",
	severity: "critical",
	opened_value: 1620,
	baseline_median: 412,
	baseline_sigma: 100,
	threshold_value: 640,
	last_observed_value: 1840,
	last_sample_count: 3100,
	first_triggered_at: new Date(NOW - 3_600_000).toISOString(),
	last_triggered_at: new Date(NOW - 60_000).toISOString(),
	resolved_at: null,
	resolve_reason: null,
	triage_status: "completed",
	fingerprints: [],
	reopen_count: 0,
	last_reopened_at: null,
})

const route = { _tag: "Anomaly" as const, incidentId: ID }

const loaded = () => {
	const entered = init(route, context)
	const clocked = pageUpdate(entered.model, Message.ReadClock({ nowMs: NOW })).model
	return pageUpdate(
		clocked,
		Message.CompletedFetchIncident({ key: clocked.incident.key ?? "", result: Result.succeed(incident) }),
	)
}

describe("anomaly detail", () => {
	test("entry reads the clock, the incident and the chart runtime; the series follows the incident", () => {
		expect(names(init(route, context).commands)).toEqual(
			expect.arrayContaining(["ReadAnomalyClock", "FetchAnomalyIncident"]),
		)
		expect(names(loaded().commands)).toEqual(["FetchAnomalyTimeseries"])
	})

	test("a typed 404 is the not-found body, other failures the error state", () => {
		const entered = init(route, context).model
		const fail = (error: unknown) =>
			pageUpdate(
				entered,
				Message.CompletedFetchIncident({
					key: entered.incident.key ?? "",
					result: Result.fail(toLoadFailure(error)),
				}),
			).model
		const notFound = new AnomalyIncidentNotFoundError({
			message: "Anomaly incident not found",
			incidentId: ID,
		})
		scene(
			{ update: pageUpdate, view },
			given(fail(notFound)),
			themed(),
			expectView(text("Anomaly not found")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(fail(new Error("down"))),
			themed(),
			expectView(text("Failed to load anomaly")).toExist(),
		)
	})

	test("resolving sends one request, then toasts and re-reads the incident", () => {
		const model = loaded().model
		const started = pageUpdate(model, Message.ClickedConfirmResolve())
		expect(names(started.commands)).toEqual(["ResolveAnomalyIncident"])
		expect(pageUpdate(started.model, Message.ClickedConfirmResolve()).commands ?? []).toHaveLength(0)
		const done = pageUpdate(started.model, Message.CompletedResolve({ result: Result.succeed(incident) }))
		expect(names(done.commands)).toContain("FetchAnomalyIncident")
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Anomaly resolved", description: "" }),
		)
	})

	test("a live-refresh read in flight when a resolve lands cannot put the open incident back", () => {
		const resolved = Schema.decodeUnknownSync(V2AnomalyIncident)({
			...Schema.encodeSync(V2AnomalyIncident)(incident),
			status: "resolved",
			resolved_at: new Date(NOW).toISOString(),
		})
		const ticked = pageUpdate(loaded().model, Message.TickedLiveRefresh({ nowMs: NOW }))
		expect(names(ticked.commands)).toContain("FetchAnomalyIncident")
		const preWriteKey = ticked.model.incident.key ?? ""
		const busy: Model["busy"] = "resolve"
		const done = pageUpdate(
			{ ...ticked.model, busy },
			Message.CompletedResolve({ result: Result.succeed(resolved) }),
		)
		expect(names(done.commands)).toContain("FetchAnomalyIncident")
		const final = [
			Message.CompletedFetchIncident({
				key: done.model.incident.key ?? "",
				result: Result.succeed(resolved),
			}),
			Message.CompletedFetchIncident({ key: preWriteKey, result: Result.succeed(incident) }),
		].reduce((current, message) => pageUpdate(current, message).model, done.model)
		expect(Option.map(incidentOf(final), (current) => current.status)).toEqual(Option.some("resolved"))
	})

	test("Open investigation navigates to the new investigation", () => {
		const started = pageUpdate(loaded().model, Message.ClickedInvestigate())
		expect(names(started.commands)).toEqual(["CreateAnomalyInvestigation"])
		const done = pageUpdate(
			started.model,
			Message.CompletedInvestigate({ result: Result.succeed("inv-1") }),
		)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/investigations/inv-1", isReplace: false }),
		)
	})

	test("the link dialog loads the service's issues", () => {
		const opened = pageUpdate(loaded().model, Message.ClickedLinkIssue())
		expect(names(opened.commands)).toContain("FetchAnomalyLinkIssues")
		const scoped = pageUpdate(opened.model, Message.ToggledLinkScope())
		expect(names(scoped.commands)).toEqual(["FetchAnomalyLinkIssues"])
		expect(scoped.model.linkAllServices).toBe(true)
	})

	test("closing the link dialog leaves focus on the body, like legacy's trigger-less dialog", () => {
		const opened = pageUpdate(loaded().model, Message.ClickedLinkIssue()).model
		scene(
			{ update: pageUpdate, view },
			given(opened),
			themed(),
			// Resolving by instance asserts the args: no focus is handed back on close.
			Mount.resolve(
				Dialog.MountDialog({
					id: "anomaly-link-issue",
					hasTrigger: false,
					isPopupFocused: false,
					isReturningFocus: false,
				}),
				Dialog.Message.CompletedMountDialog(),
			),
			expectView(text(/^Scoped to/)).toExist(),
		)
	})

	test("a live tick reads the clock, so an open incident that went quiet turns stale", () => {
		const model = loaded().model
		scene({ update: pageUpdate, view }, given(model), themed(), expectView(text(/^Stale/)).not.toExist())
		const ticked = pageUpdate(model, Message.TickedLiveRefresh({ nowMs: NOW + 30 * 86_400_000 })).model
		scene({ update: pageUpdate, view }, given(ticked), themed(), expectView(text(/^Stale/)).toExist())
	})
})

const issueRow = (id: string, exceptionType: string) =>
	Schema.decodeUnknownSync(V2ErrorIssue)({
		id,
		object: "error_issue",
		kind: "error",
		fingerprint_hash: "1",
		service_name: "payment-svc",
		exception_type: exceptionType,
		exception_message: "",
		error_label: exceptionType,
		top_frame: "",
		workflow_state: "triage",
		priority: 1,
		severity: "critical",
		severity_source: "detector",
		source_ref: null,
		assigned_actor: null,
		lease_holder: null,
		lease_expires_at: null,
		claimed_at: null,
		notes: null,
		first_seen_at: new Date(NOW - 7_200_000).toISOString(),
		last_seen_at: new Date(NOW - 60_000).toISOString(),
		occurrence_count: 12,
		resolved_at: null,
		last_resolved_at: null,
		last_regressed_at: null,
		regression_count: 0,
		resolved_versions: [],
		snooze_until: null,
		archived_at: null,
		has_open_incident: false,
		comment_count: 0,
		open_pull_request_count: 0,
		merged_pull_request_count: 0,
	})

describe("anomaly link dialog by keyboard", () => {
	test("typing a query, ArrowDown and Enter link the matching issue", () => {
		const opened = pageUpdate(loaded().model, Message.ClickedLinkIssue()).model
		const issues = [
			issueRow("iss_YoxMYDoXSr3tsBZyBLmNMv", "NullPointer"),
			issueRow("iss_YoxMYDoXSr3tsBZyBLmNMw", "ConnectionTimeout"),
		]
		const model = pageUpdate(
			opened,
			Message.CompletedFetchLinkIssues({
				key: opened.linkIssues.key ?? "",
				result: Result.succeed(issues),
			}),
		).model
		const timeout = errorIssueFromV2(issues[1] ?? issues[0]).id
		const input = role("combobox")
		scene(
			{ update: pageUpdate, view },
			given(model),
			themed(),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			type(input, "Timeout"),
			expectView(role("option", { name: /ConnectionTimeout/ })).toExist(),
			keydown(input, "ArrowDown"),
			keydown(input, "Enter"),
			Command.expectHas(SetIncidentIssue({ id: ID, issueId: timeout })),
			Command.resolve(
				SetIncidentIssue,
				Message.CompletedSetIssue({
					issueId: timeout,
					result: Result.fail(toLoadFailure(new Error("down"))),
				}),
			),
		)
	})
})
