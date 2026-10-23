import { OrgId } from "@maple/domain"
import { SecurityAuditRunNotInProgressError } from "@maple/domain/http"
import { SecurityAuditRunId } from "@maple/domain/security-audit"
import { Result, Schema } from "effect"
import { expect as expectView, given, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import { eventsOf, findingsOf, RUN_IDS, runDetailOf, targetsOf, unitsOf } from "../../../lab/security-fixture"
import { AppRoute } from "../../../route"
import type { PageContext } from "../../contract"
import { phasesOf } from "./derive"
import { Message, type Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const NOW = Date.UTC(2026, 9, 23, 14, 32)
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const routeOf = (runId: string) =>
	AppRoute.SecurityRun({ runId: Schema.decodeSync(SecurityAuditRunId)(runId) })

const loaded = (runId: string, finished = false): Model => {
	const entered = init(routeOf(runId), context).model
	const withRun = [
		Message.ReadClock({ nowMs: NOW }),
		Message.CompletedFetchRun({
			key: entered.run.key ?? "",
			result: Result.succeed(runDetailOf(NOW, runId)),
		}),
		Message.CompletedFetchEvents({
			key: entered.events.key ?? "",
			result: Result.succeed(eventsOf(NOW, finished)),
		}),
		Message.CompletedFetchUnits({ key: entered.units.key ?? "", result: Result.succeed(unitsOf()) }),
		Message.CompletedFetchTargets({
			key: entered.targets.key ?? "",
			result: Result.succeed(targetsOf(NOW)),
		}),
	].reduce((model, message) => pageUpdate(model, message).model, entered)
	const target = runDetailOf(NOW, runId).targetId
	return pageUpdate(
		withRun,
		Message.CompletedFetchFindings({
			key: withRun.findings.key ?? "",
			result: Result.succeed(findingsOf(NOW, target)),
		}),
	).model
}

describe("security run", () => {
	test("entry reads the run, its events, its ledger and the targets; the findings follow the run", () => {
		expect(names(init(routeOf(RUN_IDS.dashboard), context).commands)).toEqual(
			expect.arrayContaining([
				"SecurityApiGetRun",
				"SecurityApiListRunEvents",
				"SecurityApiListRunUnits",
				"SecurityApiListRunTargets",
			]),
		)
		const entered = init(routeOf(RUN_IDS.dashboard), context).model
		const run = pageUpdate(
			entered,
			Message.CompletedFetchRun({
				key: entered.run.key ?? "",
				result: Result.succeed(runDetailOf(NOW, RUN_IDS.dashboard)),
			}),
		)
		expect(names(run.commands)).toEqual(["SecurityApiListRunFindings"])
	})

	test("a live run shows hunting as the active phase", () => {
		const model = loaded(RUN_IDS.dashboard)
		const phases = phasesOf(runDetailOf(NOW, RUN_IDS.dashboard), eventsOf(NOW).events)
		expect(phases.map((phase) => phase.state)).toEqual([
			"done",
			"active",
			"pending",
			"pending",
			"pending",
		])
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Coverage ledger")).toExist(),
			expectView(text("Cancel run")).toExist(),
		)
	})

	test("a quick run that ran out of budget marks hunting with gaps and skips verification", () => {
		const phases = phasesOf(runDetailOf(NOW, RUN_IDS.billing), eventsOf(NOW, true).events)
		expect(phases.map((phase) => phase.state)).toEqual(["done", "warn", "done", "skipped", "done"])
		scene(
			{ update: pageUpdate, view },
			given(loaded(RUN_IDS.billing, true)),
			expectView(text("Stopped at its budget of 120 invocations")).toExist(),
			expectView(text("Gaps")).toExist(),
		)
	})

	test("a cancelled run reads as cancelled, not as a budget gap", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(RUN_IDS.billingCancelled, true)),
			expectView(text("Cancelled")).toExist(),
			expectView(text(/^Stopped at its budget/)).not.toExist(),
		)
	})

	test("a unit that did not decode shows its coverage id", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(RUN_IDS.dashboard)),
			expectView(text("u-legacy-7f2a91")).toExist(),
		)
	})

	test("confirming cancel sends it once; a run that already finished says so", () => {
		const model = loaded(RUN_IDS.dashboard)
		const confirmed = pageUpdate(model, Message.ClickedConfirmCancel())
		expect(names(confirmed.commands)).toEqual(["SecurityApiCancelRun"])
		expect(names(pageUpdate(confirmed.model, Message.ClickedConfirmCancel()).commands)).toEqual([])
		const refused = pageUpdate(
			confirmed.model,
			Message.CompletedCancel({
				result: Result.fail(
					toLoadFailure(
						new SecurityAuditRunNotInProgressError({ message: "finished", runId: model.runId }),
					),
				),
			}),
		)
		expect(refused.outMessage).toMatchObject({
			_tag: "RequestedToast",
			title: "The run had already finished",
		})
		expect(names(refused.commands)).toEqual(expect.arrayContaining(["SecurityApiGetRun"]))
	})

	test("load older asks for events before the oldest one on screen", () => {
		const older = pageUpdate(loaded(RUN_IDS.dashboard), Message.ClickedLoadOlder())
		expect(names(older.commands)).toEqual(["SecurityApiListOlderRunEvents"])
		expect(older.model.isLoadingOlder).toBe(true)
	})
})
