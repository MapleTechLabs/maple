import { OrgId } from "@maple/domain"
import { StatusPagePublicId } from "@maple/domain/http/v2"
import * as Policy from "@maple/domain/policy"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, test } from "vitest"
import type { PageContext } from "../../contract"
import { ORG } from "../../kit/alert-test-rows"
import { downMonitor, httpMonitor } from "../../kit/uptime/test-monitors"
import { component, incident, incidentId, statusPage } from "../shared/test-pages"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

// An observer reads a status page and its incidents; posting, updating, editing and deleting an
// incident or maintenance need `status_page_incidents:post`.

const context: PageContext = { orgId: Schema.decodeSync(OrgId)(ORG), pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const MEMBER = Policy.grantsOf(["org:member"])
const OBSERVER = Policy.grantsOf(["org:observer"])

/** The editor's Page tab over `incidents`, read by a session holding `grants`. */
const loaded = (
	grants: ReadonlyArray<Policy.Permission>,
	incidents: ReadonlyArray<ReturnType<typeof incident>>,
): Model => {
	const entered = init(
		{ _tag: "StatusPage", pageId: Schema.encodeSync(StatusPagePublicId)(statusPage().id), search: {} },
		context,
	).model
	return Arr.reduce(
		[
			Message.ReadClock({ nowMs: Date.UTC(2026, 9, 1, 12) }),
			Message.CompletedFetchSession({ orgId: ORG, grants }),
			Message.CompletedFetchPage({ key: entered.page.key ?? "", result: Result.succeed(statusPage()) }),
			Message.CompletedFetchComponents({
				key: entered.components.key ?? "",
				result: Result.succeed([component(1), component(2)]),
			}),
			Message.CompletedFetchIncidents({
				key: entered.incidents.key ?? "",
				result: Result.succeed(incidents),
			}),
			Message.CompletedFetchMonitors({
				key: entered.monitors.key ?? "",
				result: Result.succeed([httpMonitor(), downMonitor()]),
			}),
		],
		entered,
		(model, message) => pageUpdate(model, message).model,
	)
}

const DRAFT = incident(1, { published: false })
const MAINTENANCE = incident(2, { kind: "maintenance", title: "Database upgrade" })

const opened = (grants: ReadonlyArray<Policy.Permission>, row: ReturnType<typeof incident>, n: number) =>
	pageUpdate(loaded(grants, [row]), Message.ClickedIncident({ incidentId: incidentId(n) })).model

describe("status page editor, observer", () => {
	test("Post incident is offered to a member and not to an observer", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(OBSERVER, [])),
			expectView(text("Nothing posted.")).toExist(),
			expectView(role("button", { name: "Post incident" })).toBeAbsent(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded(MEMBER, [])),
			expectView(text("Nothing posted. Post incident when something breaks.")).toExist(),
			expectView(role("button", { name: "Post incident" })).toExist(),
		)
	})

	test("an observer reads an open incident's updates and gets none of its actions", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened(OBSERVER, DRAFT, 1)),
			expectView(text("Draft, not public")).toExist(),
			expectView(role("region", { name: "Updates" })).toExist(),
			expectView(role("button", { name: "Publish" })).toBeAbsent(),
			expectView(role("button", { name: "Post update" })).toBeAbsent(),
			expectView(role("button", { name: "Resolve" })).toBeAbsent(),
			expectView(role("button", { name: "Edit details" })).toBeAbsent(),
			expectView(role("button", { name: "Delete incident" })).toBeAbsent(),
		)
	})

	test("a member publishes, updates, resolves, edits and deletes an incident", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened(MEMBER, DRAFT, 1)),
			expectView(role("button", { name: "Publish" })).toExist(),
			expectView(role("button", { name: "Post update" })).toExist(),
			expectView(role("button", { name: "Resolve" })).toExist(),
			expectView(role("button", { name: "Edit details" })).toExist(),
			expectView(role("button", { name: "Delete incident" })).toExist(),
		)
	})

	test("a maintenance notice is the same: a member completes or deletes it, an observer reads it", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened(OBSERVER, MAINTENANCE, 2)),
			expectView(role("button", { name: "Complete" })).toBeAbsent(),
			expectView(role("button", { name: "Delete maintenance" })).toBeAbsent(),
		)
		scene(
			{ update: pageUpdate, view },
			given(opened(MEMBER, MAINTENANCE, 2)),
			expectView(role("button", { name: "Complete" })).toExist(),
			expectView(role("button", { name: "Delete maintenance" })).toExist(),
		)
	})
})
