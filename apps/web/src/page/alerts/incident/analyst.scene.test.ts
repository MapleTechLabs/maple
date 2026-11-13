import { OrgId } from "@maple/domain"
import * as Policy from "@maple/domain/policy"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { buildAlertsLabFixture } from "../../../lab/alerts-fixture"
import type { PageContext } from "../../contract"
import { incidentRow, INCIDENT_ID, NOW, ORG, ruleRow } from "../../kit/alert-test-rows"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

// An analyst reads the incident; acknowledging it needs `incidents:respond` and starting an
// investigation from it needs `investigations:run`.

const context: PageContext = { orgId: Schema.decodeSync(OrgId)(ORG), pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const themed = () => Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

const MEMBER = Policy.grantsOf(["org:member"])
const ANALYST = Policy.grantsOf(["org:analyst"])

type Fixture = Readonly<{
	grants: ReadonlyArray<Policy.Permission>
	row?: Parameters<typeof incidentRow>[0]
	hasInvestigation?: boolean
}>

/** The open incident and its rule, with the session and the investigation read answered. */
const loaded = (fixture: Fixture): Model => {
	const synced = Arr.reduce(
		[
			Message.ReadClock({ nowMs: NOW }),
			Message.UpdatedIncidents({ orgId: ORG, rows: [incidentRow(fixture.row)] }),
			Message.UpdatedRules({ orgId: ORG, rows: [ruleRow(2)] }),
			Message.CompletedFetchSession({ grants: fixture.grants }),
		],
		init({ _tag: "AlertIncident", incidentId: INCIDENT_ID, search: {} }, context).model,
		(model, message) => pageUpdate(model, message).model,
	)
	return pageUpdate(
		synced,
		Message.CompletedFetchInvestigation({
			key: synced.investigation.key ?? "",
			result: Result.succeed(
				fixture.hasInvestigation === true ? buildAlertsLabFixture(NOW).incident.investigation : null,
			),
		}),
	).model
}

const ACKNOWLEDGED = {
	acknowledged_at: new Date(NOW - 60_000).toISOString(),
	acknowledged_by_name: "Dana Kim",
	acknowledged_via: "slack",
}

describe("alert incident, analyst", () => {
	test("an analyst is not offered Acknowledge or Investigate, and a member is", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ grants: ANALYST })),
			themed(),
			expectView(role("button", { name: "Acknowledge" })).toBeAbsent(),
			expectView(role("button", { name: "Investigate" })).toBeAbsent(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded({ grants: MEMBER })),
			themed(),
			expectView(role("button", { name: "Acknowledge" })).toExist(),
			expectView(role("button", { name: "Investigate" })).toExist(),
		)
	})

	test("an analyst reads who acknowledged it and is not offered Unacknowledge", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ grants: ANALYST, row: ACKNOWLEDGED })),
			themed(),
			expectView(text(/Acknowledged by Dana Kim at/)).toExist(),
			expectView(role("button", { name: "Unacknowledge" })).toBeAbsent(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded({ grants: MEMBER, row: ACKNOWLEDGED })),
			themed(),
			expectView(role("button", { name: "Unacknowledge" })).toExist(),
		)
	})

	test("an analyst can still open an investigation that already ran", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ grants: ANALYST, hasInvestigation: true })),
			themed(),
			expectView(role("link", { name: "Open investigation" })).toExist(),
		)
	})
})
