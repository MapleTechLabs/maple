import { OrgId } from "@maple/domain"
import {
	type SecurityAuditEvent,
	SecurityAuditPersistenceError,
	SecurityAuditRunNotInProgressError,
} from "@maple/domain/http"
import { SecurityAuditRunId } from "@maple/domain/security-audit"
import { Result, Schema } from "effect"
import { expect as expectView, given, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import { eventsOf, findingsOf, RUN_IDS, runDetailOf, targetsOf, unitsOf } from "../../../lab/security-fixture"
import { AppRoute } from "../../../route"
import type { PageContext } from "../../contract"
import { eventsOf as eventLogOf, phasesOf } from "./derive"
import { subscriptions } from "./index"
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

const loaded = (runId: string): Model => {
	const entered = init(routeOf(runId), context).model
	const withRun = [
		Message.ReadClock({ nowMs: NOW }),
		Message.CompletedFetchRun({
			key: entered.run.key ?? "",
			result: Result.succeed(runDetailOf(NOW, runId)),
		}),
		Message.CompletedFetchEvents({
			key: entered.events.key ?? "",
			result: Result.succeed(eventsOf(NOW, runId)),
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

const note = (index: number): SecurityAuditEvent => ({
	id: `n${String(index).padStart(5, "0")}`,
	at: NOW + index * 1000,
	kind: "Note",
	role: null,
	agentId: null,
	outcome: null,
	message: `event ${index}`,
	phase: null,
	detail: null,
	costUsd: null,
	inputTokens: null,
	outputTokens: null,
})

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
		const phases = phasesOf(runDetailOf(NOW, RUN_IDS.dashboard), eventsOf(NOW, RUN_IDS.dashboard).events)
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
		const phases = phasesOf(runDetailOf(NOW, RUN_IDS.billing), eventsOf(NOW, RUN_IDS.billing).events)
		expect(phases.map((phase) => phase.state)).toEqual(["done", "warn", "done", "skipped", "done"])
		scene(
			{ update: pageUpdate, view },
			given(loaded(RUN_IDS.billing)),
			expectView(text("Stopped at its budget of 120 invocations")).toExist(),
			expectView(text("Gaps")).toExist(),
		)
	})

	test("a source-only run says, under its title, why it executed no target code", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(RUN_IDS.billing)),
			expectView(
				text(
					/^Source-only review: no execution sandbox for Node\.js, Go yet; private dependencies detected/,
				),
			).toExist(),
		)
	})

	test("a cancelled run reads as cancelled, not as a budget gap", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(RUN_IDS.billingCancelled)),
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

	test("Retry re-reads the findings when the Results panel failed to load them", () => {
		const entered = loaded(RUN_IDS.dashboard)
		const failed = pageUpdate(
			entered,
			Message.CompletedFetchFindings({
				key: entered.findings.key ?? "",
				result: Result.fail(
					toLoadFailure(new SecurityAuditPersistenceError({ message: "unavailable" })),
				),
			}),
		).model
		expect(names(pageUpdate(failed, Message.ClickedRetry()).commands)).toContain(
			"SecurityApiListRunFindings",
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

	test("a cancelled run with units never assigned does not show hunting as done", () => {
		const phases = phasesOf(
			runDetailOf(NOW, RUN_IDS.billingCancelled),
			eventsOf(NOW, RUN_IDS.billingCancelled).events,
		)
		expect(phases[1]?.state).toBe("stopped")
		const finishedWithGaps = phasesOf(runDetailOf(NOW, RUN_IDS.billingCancelled), [
			...eventsOf(NOW, RUN_IDS.billing).events,
		])
		expect(finishedWithGaps[1]?.state).toBe("warn")
	})

	test("events polled after Load older are kept: a newer page that pushes old ones off leaves no gap", () => {
		const event = (index: number): SecurityAuditEvent => ({
			id: `e${String(index).padStart(4, "0")}`,
			at: NOW + index * 1000,
			kind: "Agent",
			role: "hunter",
			agentId: null,
			outcome: "ok",
			message: `event ${index}`,
			phase: null,
			detail: null,
			costUsd: null,
			inputTokens: null,
			outputTokens: null,
		})
		const pageOf = (from: number, to: number) =>
			Array.from({ length: to - from + 1 }, (_, offset) => event(to - offset))
		const entered = init(routeOf(RUN_IDS.dashboard), context).model
		// First poll: events 200..399. Load older: 0..199.
		const first = pageUpdate(
			entered,
			Message.CompletedFetchEvents({
				key: entered.events.key ?? "",
				result: Result.succeed({ events: pageOf(200, 399) }),
			}),
		).model
		const older = pageUpdate(
			pageUpdate(first, Message.ClickedLoadOlder()).model,
			Message.CompletedFetchOlderEvents({ result: Result.succeed({ events: pageOf(0, 199) }) }),
		).model
		// Next poll: 300..499, which pushes 200..299 off the newest page.
		const polled = pageUpdate(older, Message.TickedPoll({ nowMs: NOW })).model
		const next = pageUpdate(
			polled,
			Message.CompletedFetchEvents({
				key: polled.events.key ?? "",
				result: Result.succeed({ events: pageOf(300, 499) }),
			}),
		).model
		const ids = eventLogOf(next).map((logged) => logged.id)
		expect(ids).toHaveLength(500)
		expect(ids[0]).toBe("e0499")
		expect(ids.at(-1)).toBe("e0000")
	})

	test("a full newer page that does not reach the held events reads older pages until it does", () => {
		const event = (index: number): SecurityAuditEvent => ({
			id: `g${String(index).padStart(4, "0")}`,
			at: NOW + index * 1000,
			kind: "Note",
			role: null,
			agentId: null,
			outcome: null,
			message: `event ${index}`,
			phase: null,
			detail: null,
			costUsd: null,
			inputTokens: null,
			outputTokens: null,
		})
		const pageOf = (from: number, to: number) =>
			Array.from({ length: to - from + 1 }, (_, offset) => event(to - offset))
		const entered = init(routeOf(RUN_IDS.dashboard), context).model
		const first = pageUpdate(
			entered,
			Message.CompletedFetchEvents({
				key: entered.events.key ?? "",
				result: Result.succeed({ events: pageOf(0, 9) }),
			}),
		).model
		const polled = pageUpdate(first, Message.TickedPoll({ nowMs: NOW })).model
		// 600 more happened: the newest page is 410..609 and does not reach event 9.
		const gapped = pageUpdate(
			polled,
			Message.CompletedFetchEvents({
				key: polled.events.key ?? "",
				result: Result.succeed({ events: pageOf(410, 609) }),
			}),
		)
		expect(names(gapped.commands)).toEqual(["SecurityApiListOlderRunEvents"])
		const filled = pageUpdate(
			gapped.model,
			Message.CompletedFetchOlderEvents({ result: Result.succeed({ events: pageOf(210, 409) }) }),
		)
		expect(names(filled.commands)).toEqual(["SecurityApiListOlderRunEvents"])
		// The page right above the held events cannot tell it is adjacent; the next one overlaps.
		const adjacent = pageUpdate(
			filled.model,
			Message.CompletedFetchOlderEvents({ result: Result.succeed({ events: pageOf(10, 209) }) }),
		)
		const closed = pageUpdate(
			adjacent.model,
			Message.CompletedFetchOlderEvents({ result: Result.succeed({ events: pageOf(0, 9) }) }),
		)
		expect(names(closed.commands)).toEqual([])
		expect(eventLogOf(closed.model)).toHaveLength(610)
	})

	test("a gap found while an older page is loading is read once that page settles", () => {
		const pageOf = (from: number, to: number) =>
			Array.from({ length: to - from + 1 }, (_, offset) => note(to - offset))
		const entered = init(routeOf(RUN_IDS.dashboard), context).model
		const first = pageUpdate(
			entered,
			Message.CompletedFetchEvents({
				key: entered.events.key ?? "",
				result: Result.succeed({ events: pageOf(1000, 1009) }),
			}),
		).model
		const loadingOlder = pageUpdate(first, Message.ClickedLoadOlder()).model
		const polled = pageUpdate(loadingOlder, Message.TickedPoll({ nowMs: NOW })).model
		// 600 newer events: a gap, found while the older page is still in flight.
		const gapped = pageUpdate(
			polled,
			Message.CompletedFetchEvents({
				key: polled.events.key ?? "",
				result: Result.succeed({ events: pageOf(1410, 1609) }),
			}),
		)
		expect(names(gapped.commands)).toEqual([])
		const settled = pageUpdate(
			gapped.model,
			Message.CompletedFetchOlderEvents({ result: Result.succeed({ events: pageOf(990, 999) }) }),
		)
		expect(settled.commands?.[0]?.name).toBe("SecurityApiListOlderRunEvents")
		expect(settled.commands?.[0]?.args).toMatchObject({ beforeId: note(1410).id })
	})

	test("the backfill stops when the API returns a page that adds nothing", () => {
		const pageOf = (from: number, to: number) =>
			Array.from({ length: to - from + 1 }, (_, offset) => note(to - offset))
		const entered = init(routeOf(RUN_IDS.dashboard), context).model
		const first = pageUpdate(
			entered,
			Message.CompletedFetchEvents({
				key: entered.events.key ?? "",
				result: Result.succeed({ events: pageOf(0, 9) }),
			}),
		).model
		const polled = pageUpdate(first, Message.TickedPoll({ nowMs: NOW })).model
		const gapped = pageUpdate(
			polled,
			Message.CompletedFetchEvents({
				key: polled.events.key ?? "",
				result: Result.succeed({ events: pageOf(410, 609) }),
			}),
		)
		expect(names(gapped.commands)).toEqual(["SecurityApiListOlderRunEvents"])
		// A misbehaving API answers with the same page again.
		const repeated = pageUpdate(
			gapped.model,
			Message.CompletedFetchOlderEvents({ result: Result.succeed({ events: pageOf(410, 609) }) }),
		)
		expect(names(repeated.commands)).toEqual([])
		expect(repeated.model.isLoadingOlder).toBe(false)
	})

	test("a failed poll of a live run keeps its last read on screen and the poll running", () => {
		const live = loaded(RUN_IDS.dashboard)
		const polled = pageUpdate(live, Message.TickedPoll({ nowMs: NOW })).model
		const failed = pageUpdate(
			polled,
			Message.CompletedFetchRun({
				key: polled.run.key ?? "",
				result: Result.fail(
					toLoadFailure(new SecurityAuditPersistenceError({ message: "unavailable" })),
				),
			}),
		).model
		expect(subscriptions.live.modelToDependencies({ model: failed, context })).toEqual({ isLive: true })
		expect(names(pageUpdate(failed, Message.TickedPoll({ nowMs: NOW + 5_000 })).commands)).toContain(
			"SecurityApiGetRun",
		)
	})

	test("a run that finishes reads its events and ledger once more", () => {
		const live = loaded(RUN_IDS.dashboard)
		const polled = pageUpdate(live, Message.TickedPoll({ nowMs: NOW })).model
		const finished = {
			...runDetailOf(NOW, RUN_IDS.dashboard),
			status: "complete" as const,
			finishedAt: NOW,
		}
		const answered = pageUpdate(
			polled,
			Message.CompletedFetchRun({ key: polled.run.key ?? "", result: Result.succeed(finished) }),
		)
		expect(names(answered.commands)).toEqual(
			expect.arrayContaining([
				"SecurityApiListRunEvents",
				"SecurityApiListRunUnits",
				"SecurityApiListRunFindings",
			]),
		)
	})

	test("load older asks for events before the oldest one on screen", () => {
		const older = pageUpdate(loaded(RUN_IDS.dashboard), Message.ClickedLoadOlder())
		expect(names(older.commands)).toEqual(["SecurityApiListOlderRunEvents"])
		expect(older.model.isLoadingOlder).toBe(true)
	})
})
