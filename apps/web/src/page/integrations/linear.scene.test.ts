import { OrgId } from "@maple/domain"
import * as Policy from "@maple/domain/policy"
import { LinearIntegrationStatus } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { click, Command, expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import type { PageContext } from "../contract"
import { STATUS_READS } from "./command"
import { LinearMessage, SaveLinearFeatures } from "./linear"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const ALL_ON = {
	openIssuesEnabled: true,
	updateCommentsEnabled: true,
	reopenIssuesEnabled: true,
	resolveCommentsEnabled: true,
}

const connected = (features = ALL_ON) =>
	Schema.decodeSync(LinearIntegrationStatus)({
		connected: true,
		workspaceName: "Acme",
		connectedByUserId: null,
		revoked: false,
		features,
	})

const loaded = (): Model => {
	const model = init({ search: { integration: "linear" } }, context).model
	return pageUpdate(
		model,
		Message.CompletedLoadLinear({
			key: model.statuses.linear.key ?? "",
			result: Result.succeed(connected()),
		}),
	).model
}

describe("linear feature switches", () => {
	test("a member sees every switch locked, with the permission it needs", () => {
		const member = { ...loaded(), grants: Policy.grantsOf(["org:member"]) }
		scene(
			{ update: pageUpdate, view },
			given(member),
			expectView(role("switch", { name: "Reopen closed issues" })).toBeDisabled(),
			expectView(role("switch", { name: "Open issues" })).toBeDisabled(),
			expectView(role("group", { name: Policy.denialFor("integrations:manage").message })).toExist(),
		)
	})

	test("turning reopening off saves only that switch and keeps it off once the status re-reads", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			expectView(role("switch", { name: "Reopen closed issues" })).toBeChecked(),
			click(role("switch", { name: "Reopen closed issues" })),
			Command.expectHas(SaveLinearFeatures({ flag: "reopenIssuesEnabled", enabled: false })),
			expectView(role("switch", { name: "Reopen closed issues" })).not.toBeChecked(),
			expectView(role("switch", { name: "Open issues" })).toBeDisabled(),
			Command.resolve(SaveLinearFeatures, LinearMessage.CompletedFeatures({ failure: null })),
			expectView(role("switch", { name: "Reopen closed issues" })).not.toBeChecked(),
			Command.resolve(
				STATUS_READS.linear,
				Message.CompletedLoadLinear({
					key: "",
					result: Result.succeed(connected({ ...ALL_ON, reopenIssuesEnabled: false })),
				}),
			),
			expectView(role("switch", { name: "Reopen closed issues" })).not.toBeChecked(),
		)
	})

	test("a failed save puts the switch back and says why", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			click(role("switch", { name: "Open issues" })),
			Command.resolve(
				SaveLinearFeatures,
				LinearMessage.CompletedFeatures({ failure: toLoadFailure("Linear is down") }),
			),
			expectView(role("switch", { name: "Open issues" })).toBeChecked(),
			expectView(text("Couldn't save that change")).toExist(),
			Command.resolve(
				STATUS_READS.linear,
				Message.CompletedLoadLinear({ key: "", result: Result.succeed(connected()) }),
			),
			// The re-read does not hide why the change did not save.
			expectView(text("Couldn't save that change")).toExist(),
		)
	})
})
