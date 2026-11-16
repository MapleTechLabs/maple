import { OrgId } from "@maple/domain"
import {
	type SecurityAuditEvent,
	type SecurityAuditFinding,
	SecurityAuditPersistenceError,
	SecurityAuditRunNotInProgressError,
} from "@maple/domain/http"
import { SecurityAuditRunId, SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Option, Result, Schema, Array as Arr, String as Str } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import {
	DEEP_RUN_IDS,
	eventsOf,
	labTargetsOf,
	RUN_IDS,
	runDetailOf,
	TARGET_IDS,
	runFindingsOf,
	unitsOf,
} from "../../../lab/security-fixture"
import { AppRoute } from "../../../route"
import type { PageContext } from "../../contract"
import { eventsOf as eventLogOf, openFindingOf, phasesOf, resultsOf } from "./derive"
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
	Arr.map(commands ?? [], ({ name }) => name)
const routeOf = (runId: string) =>
	AppRoute.SecurityRun({ runId: Schema.decodeSync(SecurityAuditRunId)(runId) })

const loaded = (runId: string): Model => {
	const entered = init(routeOf(runId), context).model
	const withRun = Arr.reduce(
		[
			Message.ReadClock({ nowMs: NOW }),
			Message.CompletedFetchRun({
				key: entered.run.key ?? "",
				result: Result.succeed(runDetailOf(NOW, runId)),
			}),
			Message.CompletedFetchEvents({
				key: entered.events.key ?? "",
				result: Result.succeed(eventsOf(NOW, runId)),
			}),
			Message.CompletedFetchUnits({
				key: entered.units.key ?? "",
				result: Result.succeed(unitsOf(runId)),
			}),
			Message.CompletedFetchTargets({
				key: entered.targets.key ?? "",
				result: Result.succeed(labTargetsOf(NOW)),
			}),
		],
		entered,
		(model, message) => pageUpdate(model, message).model,
	)
	return pageUpdate(
		withRun,
		Message.CompletedFetchFindings({
			key: withRun.findings.key ?? "",
			result: Result.succeed(runFindingsOf(NOW, runId)),
		}),
	).model
}

/** A finished run with "How the run ran" unfolded: phases, totals, ledger and events. */
const unfolded = (runId: string): Model => pageUpdate(loaded(runId), Message.ToggledDetails()).model

const note = (index: number): SecurityAuditEvent => ({
	id: `n${Str.padStart(5, "0")(String(index))}`,
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
	test("entry reads the run, its events, its ledger, the targets and the run's own findings at once", () => {
		expect(names(init(routeOf(RUN_IDS.dashboard), context).commands)).toEqual(
			expect.arrayContaining([
				"SecurityApiGetRun",
				"SecurityApiListRunEvents",
				"SecurityApiListRunUnits",
				"SecurityApiListRunTargets",
				"SecurityApiListRunFindings",
			]),
		)
	})

	test("a finished run leads with its findings by severity and folds how it ran", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(RUN_IDS.billing)),
			expectView(role("group", { name: "Severity" })).toExist(),
			expectView(role("button", { name: /^Critical/ })).toHaveAttr("aria-pressed", "false"),
			expectView(text("Refund endpoint skips the invoice ownership check")).toExist(),
			expectView(role("button", { name: /^How the run ran/ })).toHaveAttr("aria-expanded", "false"),
			expectView(text("Gaps")).not.toExist(),
		)
	})

	test("an earlier run still lists a finding a later run saw again", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(RUN_IDS.billingCancelled)),
			expectView(text("Refund endpoint skips the invoice ownership check")).toExist(),
			expectView(text("New")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded(RUN_IDS.billing)),
			expectView(text("Seen before")).toExist(),
		)
	})

	test("a severity tab narrows the list to its group, and All shows every group again", () => {
		const picked = pageUpdate(loaded(RUN_IDS.billing), Message.PickedSeverity({ bucket: "high" })).model
		scene(
			{ update: pageUpdate, view },
			given(picked),
			expectView(text("Webhook replay accepted after signature window")).toExist(),
			expectView(text("Refund endpoint skips the invoice ownership check")).not.toExist(),
		)
		expect(pageUpdate(picked, Message.PickedSeverity({ bucket: null })).model.severity).toBeNull()
	})

	test("disproved findings start folded and open on their header", () => {
		const model = loaded(RUN_IDS.billing)
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Admin export reachable without role check")).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate(model, Message.ToggledSection({ bucket: "rejected" })).model),
			expectView(text("Admin export reachable without role check")).toExist(),
		)
	})

	test("a finding opens in the side sheet with its record", () => {
		const opened = pageUpdate(
			loaded(RUN_IDS.billing),
			Message.ClickedFinding({ fingerprint: "webhook-replay-77aa" }),
		)
		expect([opened.model.findingDialog.isOpen, openFindingOf(opened.model)?.record.title]).toEqual([
			true,
			"Webhook replay accepted after signature window",
		])
	})

	test("a live run shows hunting as the active phase", () => {
		const model = loaded(RUN_IDS.dashboard)
		const phases = phasesOf(runDetailOf(NOW, RUN_IDS.dashboard), eventsOf(NOW, RUN_IDS.dashboard).events)
		expect(Arr.map(phases, (phase) => phase.state)).toEqual([
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

	test("a quick run stopped by the org's spend limit marks hunting with gaps and skips verification", () => {
		const phases = phasesOf(runDetailOf(NOW, RUN_IDS.billing), eventsOf(NOW, RUN_IDS.billing).events)
		expect(Arr.map(phases, (phase) => phase.state)).toEqual(["done", "warn", "done", "skipped", "done"])
		scene(
			{ update: pageUpdate, view },
			given(unfolded(RUN_IDS.billing)),
			expectView(text("Stopped at the org's monthly spend limit")).toExist(),
			expectView(role("link", { name: "Raise the limit" })).toExist(),
			expectView(text("Gaps")).toExist(),
		)
	})

	test("a run that stopped for several reasons says each, how many units it left, and offers a new run", () => {
		scene(
			{ update: pageUpdate, view },
			given(unfolded(DEEP_RUN_IDS.incomplete)),
			expectView(text("Stopped adding units after wave 2")).toExist(),
			expectView(
				text(
					/Also: a lead was not re-checked; billing could not be reached\. 28 units were not audited/,
				),
			).toExist(),
			expectView(role("button", { name: "Start run" })).toExist(),
			expectView(text(/^Hunter finished: Attachment names/)).toExist(),
			// Leads count what is left to validate, not confirmed findings only.
			expectView(text("6 to validate · 2 disproved")).toExist(),
		)
	})

	test("the Problems chip narrows the events to what went wrong", () => {
		const model = pageUpdate(
			unfolded(DEEP_RUN_IDS.incomplete),
			Message.PickedEventFilter({ filter: "problems" }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Hunter failed: the agent did not answer within its time limit")).toExist(),
			expectView(
				text(/^Coverage review answer discarded: its answer did not match the format/),
			).toExist(),
			expectView(text(/^Hunter finished: Attachment names/)).not.toExist(),
		)
	})

	test("ledger units read as the surface they audit, not the skill's anchors", () => {
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate(unfolded(DEEP_RUN_IDS.incomplete), Message.ToggledLedger()).model),
			expectView(text("GET /share/:token")).toExist(),
			expectView(text("share links · Broken Access Control")).toExist(),
			expectView(text(/ATTACK-CLASSES\.md/)).not.toExist(),
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

	test("a cancelled run reads as cancelled, not as a spend limit stop", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(RUN_IDS.billingCancelled)),
			expectView(text("Cancelled")).toExist(),
			expectView(text(/^Stopped at the org's/)).not.toExist(),
		)
	})

	test("a unit that did not decode shows its coverage id", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(RUN_IDS.dashboard)),
			expectView(text("u-legacy-7f2a91")).toExist(),
		)
	})

	test("Retry re-reads the findings when the list failed to load them", () => {
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
			id: `e${Str.padStart(4, "0")(String(index))}`,
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
		const ids = Arr.map(eventLogOf(next), (logged) => logged.id)
		expect(ids).toHaveLength(500)
		expect(ids[0]).toBe("e0499")
		expect(ids.at(-1)).toBe("e0000")
	})

	test("a full newer page that does not reach the held events reads older pages until it does", () => {
		const event = (index: number): SecurityAuditEvent => ({
			id: `g${Str.padStart(4, "0")(String(index))}`,
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
		// Watched to the end, its details stay open rather than folding under the reader.
		scene(
			{ update: pageUpdate, view },
			given(answered.model),
			expectView(role("button", { name: /^How the run ran/ })).toHaveAttr("aria-expanded", "true"),
		)
	})

	test("load older asks for events before the oldest one on screen", () => {
		const older = pageUpdate(loaded(RUN_IDS.dashboard), Message.ClickedLoadOlder())
		expect(names(older.commands)).toEqual(["SecurityApiListOlderRunEvents"])
		expect(older.model.isLoadingOlder).toBe(true)
	})
})

describe("pull request run", () => {
	const BLOCKING = "preview-ssrf-3a1f"
	const ACCEPTED = "cors-credentials-5e20"
	const opened = (fingerprint: string) =>
		pageUpdate(loaded(RUN_IDS.gatewayPr), Message.ClickedFinding({ fingerprint })).model
	const dismissed = (model: Model) =>
		Arr.reduce(
			[
				Message.GotTriageMessage({
					message: ToggleGroup.Message.ClickedItem({ value: "dismissed", index: 0 }),
				}),
				Message.GotReasonMessage({
					message: Field.Message.ChangedValue({
						value: "  Previews go through the egress proxy.  ",
					}),
				}),
			],
			model,
			(next, message) => pageUpdate(next, message).model,
		)

	test("the header links the pull request on GitHub at its head commit and says what fails the check", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(RUN_IDS.gatewayPr)),
			expectView(role("link", { name: "Pull request #482" })).toHaveAttr(
				"href",
				"https://github.com/acme/api-gateway/pull/482",
			),
			expectView(text(" into main @ c0de482")).toExist(),
			expectView(text("Current rule: fails at high and above")).toExist(),
			expectView(text("Accepted risk")).toExist(),
		)
	})

	test("a confirmed finding opens with triage and, untriaged, no finding page to 404 on", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened(BLOCKING)),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(role("button", { name: "Dismiss" })).toExist(),
			expectView(role("button", { name: "Update status" })).toExist(),
			expectView(role("link", { name: /Open finding page/ })).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(opened(ACCEPTED)),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(role("link", { name: /Open finding page/ })).toExist(),
		)
	})

	test("dismissing sends the run's finding triage, then the row reads dismissed", () => {
		const submitted = pageUpdate(dismissed(opened(BLOCKING)), Message.SubmittedTriage())
		expect(
			Option.getOrUndefined(
				Arr.findFirst(
					submitted.commands ?? [],
					(command) => command.name === "SecurityApiUpdateRunFindingStatus",
				),
			)?.args,
		).toEqual({
			runId: RUN_IDS.gatewayPr,
			fingerprint: BLOCKING,
			status: "dismissed",
			reason: "Previews go through the egress proxy.",
		})
		const done = pageUpdate(
			submitted.model,
			Message.CompletedTriage({
				fingerprint: BLOCKING,
				result: Result.succeed({
					targetId: Schema.decodeSync(SecurityAuditTargetId)(TARGET_IDS.gateway),
					fingerprint: BLOCKING,
					status: "dismissed",
					statusReason: "Previews go through the egress proxy.",
					statusChangedAt: NOW,
				}),
			}),
		)
		expect(names(done.commands)).toContain("SecurityApiListRunFindings")
		expect(done.outMessage).toMatchObject({ title: "Marked dismissed" })
		scene(
			{ update: pageUpdate, view },
			given(done.model),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			// The row under the sheet, and the sheet's control, both read the new status.
			expectView(text("Dismissed")).toExist(),
			expectView(role("button", { name: "Dismiss" })).toHaveAttr("aria-pressed", "true"),
		)
	})

	/** The pull request run with its findings answered as `edit` leaves them. */
	const withFindings = (edit: (finding: SecurityAuditFinding) => SecurityAuditFinding): Model => {
		const model = loaded(RUN_IDS.gatewayPr)
		return pageUpdate(
			model,
			Message.CompletedFetchFindings({
				key: model.findings.key ?? "",
				result: Result.succeed({
					findings: Arr.map(runFindingsOf(NOW, RUN_IDS.gatewayPr).findings, edit),
				}),
			}),
		).model
	}

	test("a fixed or open finding offers only Dismiss and Accept risk; a triaged one can be reopened", () => {
		const fixed = pageUpdate(
			withFindings((finding) =>
				finding.fingerprint === BLOCKING ? { ...finding, status: "fixed" } : finding,
			),
			Message.ClickedFinding({ fingerprint: BLOCKING }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(fixed),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(role("button", { name: "Open" })).not.toExist(),
			expectView(role("button", { name: "Accept risk" })).toExist(),
			expectView(role("button", { name: "Update status" })).toHaveAttr("disabled", "true"),
		)
		const reasoned = pageUpdate(
			fixed,
			Message.GotReasonMessage({ message: Field.Message.ChangedValue({ value: "reopen it" }) }),
		).model
		expect(names(pageUpdate(reasoned, Message.SubmittedTriage()).commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(opened(ACCEPTED)),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(role("button", { name: "Open" })).toHaveAttr("aria-pressed", "false"),
			expectView(role("button", { name: "Accept risk" })).toHaveAttr("aria-pressed", "true"),
		)
	})

	test("an open finding the branch already follows still links its finding page", () => {
		const followed = pageUpdate(
			withFindings((finding) =>
				finding.fingerprint === BLOCKING
					? { ...finding, firstSeenRunId: Schema.decodeSync(SecurityAuditRunId)(RUN_IDS.gateway) }
					: finding,
			),
			Message.ClickedFinding({ fingerprint: BLOCKING }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(followed),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(role("link", { name: /Open finding page/ })).toExist(),
		)
	})

	test("a save in flight lands on its own finding; another finding opened meanwhile keeps its own draft", () => {
		const saving = pageUpdate(dismissed(opened(BLOCKING)), Message.SubmittedTriage()).model
		const onOther = pageUpdate(saving, Message.ClickedFinding({ fingerprint: ACCEPTED })).model
		expect([onOther.triage.values, onOther.reason.value]).toEqual([["accepted_risk"], ""])
		// One save at a time: the other finding cannot send while the first is in flight.
		const typed = pageUpdate(
			pageUpdate(
				onOther,
				Message.GotTriageMessage({
					message: ToggleGroup.Message.ClickedItem({ value: "open", index: 0 }),
				}),
			).model,
			Message.GotReasonMessage({ message: Field.Message.ChangedValue({ value: "Back to open." }) }),
		).model
		expect(names(pageUpdate(typed, Message.SubmittedTriage()).commands)).toEqual([])
		const savedA = pageUpdate(
			typed,
			Message.CompletedTriage({
				fingerprint: BLOCKING,
				result: Result.succeed({
					targetId: Schema.decodeSync(SecurityAuditTargetId)(TARGET_IDS.gateway),
					fingerprint: BLOCKING,
					status: "dismissed",
					statusReason: "Previews go through the egress proxy.",
					statusChangedAt: NOW,
				}),
			}),
		).model
		expect([savedA.triage.values, savedA.reason.value, openFindingOf(savedA)?.status]).toEqual([
			["open"],
			"Back to open.",
			"accepted_risk",
		])
		expect(
			Option.getOrUndefined(
				Option.map(
					Arr.findFirst(resultsOf(savedA), (finding) => finding.fingerprint === BLOCKING),
					(finding) => finding.status,
				),
			),
		).toBe("dismissed")
		// Now the other finding's own draft is what it sends.
		expect(
			Option.getOrUndefined(
				Arr.findFirst(
					pageUpdate(savedA, Message.SubmittedTriage()).commands ?? [],
					(command) => command.name === "SecurityApiUpdateRunFindingStatus",
				),
			)?.args,
		).toMatchObject({ fingerprint: ACCEPTED, status: "open", reason: "Back to open." })
	})

	test("a failed save frees the form without moving its draft to the finding open now", () => {
		const saving = pageUpdate(dismissed(opened(BLOCKING)), Message.SubmittedTriage()).model
		const onOther = pageUpdate(saving, Message.ClickedFinding({ fingerprint: ACCEPTED })).model
		const failed = pageUpdate(
			onOther,
			Message.CompletedTriage({
				fingerprint: BLOCKING,
				result: Result.fail(toLoadFailure(new SecurityAuditPersistenceError({ message: "down" }))),
			}),
		)
		expect(failed.outMessage).toMatchObject({ type: "error" })
		expect([failed.model.savingFingerprint, failed.model.triage.values]).toEqual([
			null,
			["accepted_risk"],
		])
		// Unchanged and unreasoned, the open finding sends nothing.
		expect(names(pageUpdate(failed.model, Message.SubmittedTriage()).commands)).toEqual([])
		// An answer for a save no longer in flight is dropped.
		expect(
			pageUpdate(
				failed.model,
				Message.CompletedTriage({
					fingerprint: BLOCKING,
					result: Result.fail(
						toLoadFailure(new SecurityAuditPersistenceError({ message: "late" })),
					),
				}),
			).outMessage,
		).toBeUndefined()
	})

	test("a reason is required before anything is sent", () => {
		const picked = pageUpdate(
			opened(BLOCKING),
			Message.GotTriageMessage({
				message: ToggleGroup.Message.ClickedItem({ value: "accepted_risk", index: 1 }),
			}),
		).model
		const submitted = pageUpdate(picked, Message.SubmittedTriage())
		expect([names(submitted.commands), submitted.model.isTriageSubmitted]).toEqual([[], true])
	})

	test("a branch audit's findings are triaged on the finding page, not from the run", () => {
		const model = dismissed(
			pageUpdate(
				loaded(RUN_IDS.billing),
				Message.ClickedFinding({ fingerprint: "webhook-replay-77aa" }),
			).model,
		)
		expect(names(pageUpdate(model, Message.SubmittedTriage()).commands)).toEqual([])
	})
})
