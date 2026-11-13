import { OrgId } from "@maple/domain"
import { AnomalyIncidentId } from "@maple/domain/http"
import { encodePublicId, PublicIdPrefixes, V2AnomalyIncident } from "@maple/domain/http/v2"
import * as Policy from "@maple/domain/policy"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { toLoadFailure } from "@maple/views/data/load-failure"
import type { PageContext } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

// An analyst reads the anomaly; resolving it and linking an issue need `incidents:respond`, and
// opening an investigation on it needs `investigations:run`.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const themed = () => Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))
const ID = Schema.decodeSync(AnomalyIncidentId)("0199a060-0000-7000-8000-000000000001")
const NOW = Date.UTC(2026, 9, 1, 12)

const MEMBER = Policy.grantsOf(["org:member"])
const ANALYST = Policy.grantsOf(["org:analyst"])

const incidentOf = (overrides: Readonly<Record<string, unknown>>) =>
	Schema.decodeSync(V2AnomalyIncident)({
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
		...overrides,
	})

/** The open anomaly, read by a session holding `grants`. */
const loaded = (
	grants: ReadonlyArray<Policy.Permission>,
	overrides: Readonly<Record<string, unknown>> = {},
): Model => {
	const entered = init({ _tag: "Anomaly", incidentId: ID }, context).model
	return Arr.reduce(
		[
			Message.ReadClock({ nowMs: NOW }),
			Message.CompletedFetchSession({ orgId, grants }),
			Message.CompletedFetchIncident({
				key: entered.incident.key ?? "",
				result: Result.succeed(incidentOf(overrides)),
			}),
		],
		entered,
		(model, message) => pageUpdate(model, message).model,
	)
}

/** Linked to an issue whose own read failed: the card names it and keeps its actions. */
const linked = (grants: ReadonlyArray<Policy.Permission>): Model => {
	const model = loaded(grants, { error_issue_id: "iss_YoxMYDoXSr3tsBZyBLmNMv" })
	return pageUpdate(
		model,
		Message.CompletedFetchLinkedIssue({
			key: model.linkedIssue.key ?? "",
			result: Result.fail(toLoadFailure(new Error("down"))),
		}),
	).model
}

describe("anomaly detail, analyst", () => {
	test("an analyst reads the anomaly and is not offered Resolve, Link issue or an investigation", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(ANALYST)),
			themed(),
			expectView(text("Not linked to an issue")).toExist(),
			expectView(text("Details")).toExist(),
			expectView(role("button", { name: "Resolve" })).toBeAbsent(),
			expectView(role("button", { name: "Resolve anomaly" })).toBeAbsent(),
			expectView(role("button", { name: "Link issue" })).toBeAbsent(),
			expectView(role("button", { name: "Open investigation" })).toBeAbsent(),
			expectView(text("Actions")).toBeAbsent(),
		)
	})

	test("a member is offered Resolve and an investigation", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(MEMBER)),
			themed(),
			expectView(role("button", { name: "Resolve" })).toExist(),
			expectView(role("button", { name: "Resolve anomaly" })).toExist(),
			expectView(role("button", { name: "Open investigation" })).toExist(),
			expectView(text("Actions")).toExist(),
		)
	})

	test("an analyst can open the linked issue and cannot relink or unlink it; a member can", () => {
		scene(
			{ update: pageUpdate, view },
			given(linked(ANALYST)),
			themed(),
			expectView(role("link", { name: "Open issue" })).toExist(),
			expectView(role("button", { name: "Link a different issue" })).toBeAbsent(),
			expectView(role("button", { name: "Unlink issue" })).toBeAbsent(),
		)
		scene(
			{ update: pageUpdate, view },
			given(linked(MEMBER)),
			themed(),
			expectView(role("button", { name: "Link a different issue" })).toExist(),
			expectView(role("button", { name: "Unlink issue" })).toExist(),
		)
	})

	test("an answer for another org leaves the page's grants as they were", () => {
		const model = loaded(ANALYST)
		const other = pageUpdate(model, Message.CompletedFetchSession({ orgId: "org_other", grants: MEMBER }))
		expect(other.model.grants).toEqual(ANALYST)
	})
})
