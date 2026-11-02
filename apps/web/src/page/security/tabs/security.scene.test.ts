import { OrgId } from "@maple/domain"
import {
	ApiRequestValidationError,
	SecurityAuditCreateTargetRequest,
	SecurityAuditDisabledError,
	SecurityAuditForbiddenError,
	SecurityAuditRepositoryNotConnectedError,
	SecurityAuditTargetExistsError,
} from "@maple/domain/http"
import { SecurityAuditRunId, SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Cause, Effect, Fiber, Option, Result, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import {
	findingsOf,
	githubStatusOf,
	RUN_IDS,
	runDetailOf,
	runsOf,
	settingsOf,
	TARGET_IDS,
	targetsOf,
} from "../../../lab/security-fixture"
import { AppRoute, hrefOf } from "../../../route"
import * as Dialog from "../../../ui/dialog"
import * as Field from "../../../ui/field"
import * as Select from "../../../ui/select"
import type { PageContext } from "../../contract"
import * as AddTarget from "../kit/add-target"
import * as SpendSettings from "../kit/spend-settings"
import { toCreateFailure } from "../kit/api"
import { sectionsOf } from "../kit/findings"
import {
	filteredFindings,
	findingsStateOf,
	latestRunFor,
	openLeads,
	runCountsOf,
	runningRuns,
	spendThisMonth,
} from "./derive"
import { Message, type Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
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
const overview = AppRoute.Security()

/** Targets, runs and GitHub status answered, the clock read. */
const withTargets = (route: Parameters<typeof init>[0] = overview) => {
	const entered = init(route, context).model
	return [
		Message.ReadClock({ nowMs: NOW }),
		Message.CompletedFetchTargets({
			key: entered.targets.key ?? "",
			result: Result.succeed(targetsOf(NOW)),
		}),
		Message.CompletedFetchRuns({ key: entered.runs.key ?? "", result: Result.succeed(runsOf(NOW)) }),
		Message.CompletedFetchGithubStatus({
			key: entered.githubStatus.key ?? "",
			result: Result.succeed(githubStatusOf()),
		}),
	].reduce((model, message) => pageUpdate(model, message).model, entered)
}

/** Every target's findings answered. */
const loaded = (route: Parameters<typeof init>[0] = overview): Model =>
	Object.values(TARGET_IDS).reduce(
		(model, targetId) =>
			pageUpdate(
				model,
				Message.CompletedFetchFindings({
					targetId: Schema.decodeSync(SecurityAuditTargetId)(targetId),
					key: model.findings[targetId]?.key ?? "",
					result: Result.succeed(findingsOf(NOW, targetId)),
				}),
			).model,
		withTargets(route),
	)

describe("security tabs", () => {
	test("entry reads the targets, the runs and the GitHub installation", () => {
		expect(names(init(overview, context).commands)).toEqual(
			expect.arrayContaining([
				"SecurityApiListTargets",
				"SecurityApiListRuns",
				"SecurityApiGetSettings",
				"SecurityApiGithubStatus",
			]),
		)
	})

	test("the targets answer reads each target's findings, its own runs and its latest run", () => {
		const entered = init(overview, context).model
		const runs = pageUpdate(
			entered,
			Message.CompletedFetchRuns({ key: entered.runs.key ?? "", result: Result.succeed(runsOf(NOW)) }),
		)
		const targets = pageUpdate(
			runs.model,
			Message.CompletedFetchTargets({
				key: entered.targets.key ?? "",
				result: Result.succeed(targetsOf(NOW)),
			}),
		)
		const sent = names(targets.commands)
		expect(sent.filter((name) => name === "SecurityApiListFindings")).toHaveLength(4)
		expect(sent.filter((name) => name === "SecurityApiListTargetRuns")).toHaveLength(4)
		expect(sent.filter((name) => name === "SecurityApiGetLatestRun")).toHaveLength(4)
	})

	test("a tab change keeps the instance and reads nothing again", () => {
		const moved = routeChanged(loaded(), AppRoute.SecurityFindings({ search: {} }), context)
		expect(moved.model.tab).toBe("findings")
		expect(names(moved.commands)).toEqual([])
	})

	test("a run that finishes re-reads its target's findings", () => {
		const model = loaded()
		const finished = runsOf(NOW).runs.map((run) =>
			run.id === RUN_IDS.dashboard ? { ...run, status: "complete" as const, finishedAt: NOW } : run,
		)
		const polled = pageUpdate(model, Message.TickedPoll({ nowMs: NOW + 15_000 }))
		const answered = pageUpdate(
			polled.model,
			Message.CompletedFetchRuns({
				key: polled.model.runs.key ?? "",
				result: Result.succeed({ runs: finished }),
			}),
		)
		expect(names(answered.commands)).toEqual(
			expect.arrayContaining(["SecurityApiListFindings", "SecurityApiGetLatestRun"]),
		)
		expect(answered.model.findings[TARGET_IDS.dashboard]?.data._tag).toBe("Refreshing")
	})

	test("a target's own runs do not go stale: the polled list's newer copy wins and new runs show", () => {
		const targetId = Schema.decodeSync(SecurityAuditTargetId)(TARGET_IDS.dashboard)
		const ownRuns = runsOf(NOW).runs.filter((run) => run.targetId === TARGET_IDS.dashboard)
		const withOwn = pageUpdate(
			loaded(),
			Message.CompletedFetchTargetRuns({
				targetId,
				key: loaded().targetRuns[TARGET_IDS.dashboard]?.key ?? "",
				result: Result.succeed({ runs: ownRuns }),
			}),
		).model
		expect(latestRunFor(withOwn, TARGET_IDS.dashboard)?.finishedAt).toBeNull()
		const polled = pageUpdate(withOwn, Message.TickedPoll({ nowMs: NOW + 15_000 }))
		expect(names(polled.commands)).toEqual(
			expect.arrayContaining(["SecurityApiListRuns", "SecurityApiListTargetRuns"]),
		)
		const live = ownRuns[0]
		expect(live).toBeDefined()
		if (live === undefined) return
		const next = {
			...live,
			id: Schema.decodeSync(SecurityAuditRunId)("run_next_0001"),
			startedAt: NOW + 10_000,
		}
		const finished = { ...live, status: "complete" as const, finishedAt: NOW + 5_000 }
		const answered = pageUpdate(
			polled.model,
			Message.CompletedFetchRuns({
				key: polled.model.runs.key ?? "",
				result: Result.succeed({
					runs: [
						next,
						finished,
						...runsOf(NOW).runs.filter((run) => run.targetId !== TARGET_IDS.dashboard),
					],
				}),
			}),
		)
		// The own list still says live; the merge shows the new run and the old one as finished.
		expect(latestRunFor(answered.model, TARGET_IDS.dashboard)?.id).toBe("run_next_0001")
		expect(runningRuns(answered.model).map((run) => run.id)).toEqual(["run_next_0001"])
		expect(names(answered.commands)).toContain("SecurityApiListTargetRuns")
	})

	test("polling continues while a target's own list holds a live run the global list dropped", () => {
		const targetId = Schema.decodeSync(SecurityAuditTargetId)(TARGET_IDS.dashboard)
		const ownRuns = runsOf(NOW).runs.filter((run) => run.targetId === TARGET_IDS.dashboard)
		const base = loaded()
		const withoutGlobal = pageUpdate(
			base,
			Message.CompletedFetchRuns({
				key: base.runs.key ?? "",
				result: Result.succeed({
					runs: runsOf(NOW).runs.filter((run) => run.targetId !== TARGET_IDS.dashboard),
				}),
			}),
		).model
		const withOwn = pageUpdate(
			withoutGlobal,
			Message.CompletedFetchTargetRuns({
				targetId,
				key: withoutGlobal.targetRuns[TARGET_IDS.dashboard]?.key ?? "",
				result: Result.succeed({ runs: ownRuns }),
			}),
		).model
		expect(runningRuns(withOwn)).toHaveLength(1)
	})

	test("an org outside the rollout sees the not-enabled state, not an error", () => {
		const entered = init(overview, context).model
		const disabled = pageUpdate(
			entered,
			Message.CompletedFetchTargets({
				key: entered.targets.key ?? "",
				result: Result.fail(
					toLoadFailure(
						new SecurityAuditDisabledError({ message: "Security audits are not enabled" }),
					),
				),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(disabled),
			expectView(text("Security audits are not enabled for this organization")).toExist(),
		)
	})

	test("a member's findings are gated, the targets still show", () => {
		const gated = Object.values(TARGET_IDS).reduce(
			(model, targetId) =>
				pageUpdate(
					model,
					Message.CompletedFetchFindings({
						targetId: Schema.decodeSync(SecurityAuditTargetId)(targetId),
						key: model.findings[targetId]?.key ?? "",
						result: Result.fail(
							toLoadFailure(new SecurityAuditForbiddenError({ message: "Admins only" })),
						),
					}),
				).model,
			withTargets(),
		)
		expect(findingsStateOf(gated)).toEqual({ _tag: "Gated", gate: "forbidden" })
		scene(
			{ update: pageUpdate, view },
			given(gated),
			expectView(text("acme/api-gateway")).toExist(),
			expectView(text("Findings and reports are visible to org admins only")).toExist(),
		)
	})

	test("the findings list hides rejected records until asked", () => {
		const state = findingsStateOf(loaded())
		const findings = state._tag === "Ready" ? state.findings : []
		const sectionsFor = (rejected: boolean) =>
			sectionsOf(filteredFindings(findings, rejected ? { rejected } : {}, "")).map(
				(entry) => entry.bucket,
			)
		// Both leads carry an estimate, so they sit under their severity, not in a group of their own.
		expect(sectionsFor(false)).toEqual(["critical", "high", "medium", "low"])
		expect(sectionsFor(true)).toEqual(["critical", "high", "medium", "low", "rejected"])
	})

	test("the status tab and search narrow the findings", () => {
		const state = findingsStateOf(loaded())
		const findings = state._tag === "Ready" ? state.findings : []
		expect(
			filteredFindings(findings, { status: "dismissed" }, "").map((finding) => finding.fingerprint),
		).toEqual(["ratelimit-xff-3a19"])
		expect(filteredFindings(findings, {}, "exports.ts").map((finding) => finding.fingerprint)).toEqual([
			"exports-tenant-body-8b9e",
		])
	})

	test("coverage reads as unknown, not unmapped, until the latest runs are in", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			expectView(text("Not mapped")).toBeAbsent(),
			expectView(text("no run has mapped a repository yet")).toBeAbsent(),
		)
	})

	test("Covered sums every target's latest run, and says not mapped only once no run has", () => {
		const answered = Object.values(TARGET_IDS).reduce((model, targetId) => {
			const run = latestRunFor(model, targetId)
			if (run === undefined) return model
			return pageUpdate(
				model,
				Message.CompletedFetchLatestRun({
					runId: run.id,
					key: model.latestRuns[run.id]?.key ?? "",
					result: Result.succeed(runDetailOf(NOW, run.id)),
				}),
			).model
		}, loaded())
		scene(
			{ update: pageUpdate, view },
			given(answered),
			// gateway 212 of 212, dashboard 64 of 148, billing 38 of 54.
			expectView(text("314 / 414")).toExist(),
			expectView(text("Not mapped")).toBeAbsent(),
		)

		const entered = init(overview, context).model
		const noRuns = [
			Message.ReadClock({ nowMs: NOW }),
			Message.CompletedFetchTargets({
				key: entered.targets.key ?? "",
				result: Result.succeed(targetsOf(NOW)),
			}),
			Message.CompletedFetchRuns({ key: entered.runs.key ?? "", result: Result.succeed({ runs: [] }) }),
		].reduce((model, message) => pageUpdate(model, message).model, entered)
		scene({ update: pageUpdate, view }, given(noRuns), expectView(text("Not mapped")).toExist())
	})

	test("the latest run's coverage is read for the targets table", () => {
		const model = loaded()
		const key = model.latestRuns[RUN_IDS.gateway]?.key ?? ""
		const answered = pageUpdate(
			model,
			Message.CompletedFetchLatestRun({
				runId: runDetailOf(NOW, RUN_IDS.gateway).id,
				key,
				result: Result.succeed(runDetailOf(NOW, RUN_IDS.gateway)),
			}),
		).model
		scene({ update: pageUpdate, view }, given(answered), expectView(text("212 / 212")).toExist())
	})

	test("targets that fail to load show the error with a retry on the Findings tab, not a skeleton", () => {
		const entered = init(AppRoute.SecurityFindings({ search: {} }), context).model
		const failed = pageUpdate(
			entered,
			Message.CompletedFetchTargets({
				key: entered.targets.key ?? "",
				// A response that did not decode: no automatic retry, so the button is the way back.
				result: Result.fail(toLoadFailure(new Error("unexpected body"))),
			}),
		).model
		expect(findingsStateOf(failed)._tag).toBe("Failed")
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Couldn't load findings")).toExist(),
			expectView(role("button", { name: "Try again" })).toExist(),
		)
		expect(names(pageUpdate(failed, Message.ClickedRetry()).commands)).toContain("SecurityApiListTargets")
	})

	test("this month's spend says which runs it leaves out", () => {
		const withTargetRuns = Object.values(TARGET_IDS).reduce((model, targetId) => {
			const own = runsOf(NOW).runs.filter((run) => run.targetId === targetId)
			const capped =
				targetId === TARGET_IDS.gateway
					? Array.from({ length: 50 }, () => own[0]).filter((run) => run !== undefined)
					: own
			return pageUpdate(
				model,
				Message.CompletedFetchTargetRuns({
					targetId: Schema.decodeSync(SecurityAuditTargetId)(targetId),
					key: model.targetRuns[targetId]?.key ?? "",
					// An older run past the global list's cap, with no cost recorded.
					result: Result.succeed({
						runs:
							targetId === TARGET_IDS.terraform
								? capped.flatMap((run) => [
										run,
										{
											...run,
											id: Schema.decodeSync(SecurityAuditRunId)("run_older_0001"),
											costUsd: null,
											startedAt: run.startedAt - 60_000,
										},
									])
								: capped,
					}),
				}),
			).model
		}, loaded())
		const spend = spendThisMonth(withTargetRuns)
		expect(spend.isPartial).toBe(true)
		expect(spend.unpriced).toBe(1)
		scene(
			{ update: pageUpdate, view },
			given(withTargetRuns),
			expectView(text(/models not yet priced for 1 run · newest 50 runs per target only$/)).toExist(),
		)
	})

	test("with no target, Findings hides its filters and Runs offers Add target", () => {
		const entered = init(AppRoute.SecurityFindings({ search: {} }), context).model
		const noTargets = [
			Message.ReadClock({ nowMs: NOW }),
			Message.CompletedFetchTargets({
				key: entered.targets.key ?? "",
				result: Result.succeed({ targets: [] }),
			}),
			Message.CompletedFetchRuns({ key: entered.runs.key ?? "", result: Result.succeed({ runs: [] }) }),
		].reduce((model, message) => pageUpdate(model, message).model, entered)
		scene(
			{ update: pageUpdate, view },
			given(noTargets),
			expectView(text("No findings yet")).toExist(),
			expectView(role("textbox", { name: /Search/ })).not.toExist(),
			expectView(role("link", { name: /^Open/ })).not.toExist(),
		)
		const runsTab = routeChanged(noTargets, AppRoute.SecurityRuns({ search: {} }), context).model
		scene(
			{ update: pageUpdate, view },
			given(runsTab),
			expectView(text("Add a target, then start its first run.")).toExist(),
			expectView(role("combobox", { name: "Target" })).not.toExist(),
		)
		const opened = pageUpdate(runsTab, Message.ClickedAddTarget())
		expect(opened.model.addTarget.dialog.isOpen).toBe(true)
	})

	test("Overview, Findings and Runs all offer Add target to an admin", () => {
		const model = loaded()
		for (const route of [
			overview,
			AppRoute.SecurityFindings({ search: {} }),
			AppRoute.SecurityRuns({ search: {} }),
		]) {
			scene(
				{ update: pageUpdate, view },
				given(routeChanged(model, route, context).model),
				expectView(role("button", { name: "Add target" })).toExist(),
			)
		}
	})

	test("a member sees no Add target or Start run control", () => {
		const member = pageUpdate(loaded(), Message.CompletedReadIsAdmin({ isAdmin: false })).model
		scene(
			{ update: pageUpdate, view },
			given(member),
			expectView(role("button", { name: "Add target" })).not.toExist(),
		)
		const runsTab = routeChanged(
			member,
			AppRoute.SecurityRuns({ search: { target: TARGET_IDS.gateway } }),
			context,
		).model
		scene(
			{ update: pageUpdate, view },
			given(runsTab),
			expectView(role("button", { name: "Start run" })).not.toExist(),
			expectView(role("link", { name: "Runs" })).toExist(),
		)
	})

	test("rejected findings show unfolded whether the URL or the switch asked for them", () => {
		const findings = routeChanged(loaded(), AppRoute.SecurityFindings({ search: {} }), context).model
		expect(pageUpdate(findings, Message.ToggledShowRejected()).outMessage).toMatchObject({
			url: expect.stringContaining("rejected=true"),
		})
		const shown = routeChanged(
			findings,
			AppRoute.SecurityFindings({ search: { rejected: true } }),
			context,
		).model
		const entered = init(AppRoute.SecurityFindings({ search: { rejected: true } }), context).model
		expect([findings.collapsed, shown.collapsed, entered.collapsed]).toEqual([["rejected"], [], []])
	})

	test("a severity tab picked within the search debounce keeps what was typed", () => {
		const findings = routeChanged(loaded(), AppRoute.SecurityFindings({ search: {} }), context).model
		const typed = pageUpdate(findings, Message.ChangedSearchDraft({ value: "exports" })).model
		const picked = pageUpdate(typed, Message.PickedSeverity({ bucket: "critical" }))
		expect(picked.outMessage).toMatchObject({
			_tag: "RequestedNavigation",
			url: expect.stringContaining("q="),
		})
		expect(picked.outMessage).toMatchObject({ url: expect.stringContaining("severity=") })
	})

	test("the search box commits to the URL after the debounce, and only the last keystroke does", () => {
		const findings = routeChanged(loaded(), AppRoute.SecurityFindings({ search: {} }), context).model
		const first = pageUpdate(findings, Message.ChangedSearchDraft({ value: "expo" }))
		const second = pageUpdate(first.model, Message.ChangedSearchDraft({ value: "exports" }))
		expect(names(second.commands)).toEqual(["WaitSecuritySearchDebounce"])
		expect(
			pageUpdate(second.model, Message.ElapsedSearchDebounce({ generation: 1 })).outMessage,
		).toBeUndefined()
		expect(
			pageUpdate(second.model, Message.ElapsedSearchDebounce({ generation: 2 })).outMessage,
		).toMatchObject({
			_tag: "RequestedNavigation",
			url: expect.stringContaining("q="),
		})
	})

	test("a search typed just before leaving Findings does not navigate back to it", () => {
		const findings = routeChanged(loaded(), AppRoute.SecurityFindings({ search: {} }), context).model
		const typed = pageUpdate(findings, Message.ChangedSearchDraft({ value: "exports" })).model
		const left = routeChanged(typed, AppRoute.SecurityRuns({ search: {} }), context).model
		expect(
			pageUpdate(left, Message.ElapsedSearchDebounce({ generation: typed.searchGeneration }))
				.outMessage,
		).toBeUndefined()
	})

	test("a status picked within the search debounce keeps what was typed", () => {
		const findings = routeChanged(loaded(), AppRoute.SecurityFindings({ search: {} }), context).model
		const typed = pageUpdate(findings, Message.ChangedSearchDraft({ value: "exports" })).model
		const picked = pageUpdate(
			typed,
			Message.GotStatusSelectMessage({
				message: Select.Message.SelectedItem({ index: 1, value: "fixed" }),
			}),
		)
		expect(picked.outMessage).toMatchObject({
			url: hrefOf(AppRoute.SecurityFindings({ search: { q: "exports", status: "fixed" } })),
		})
	})

	test("an empty status tab reads as filtered, with Clear filters, only when a filter besides the status is set", () => {
		const atStatus = (search: { q?: string; status: "accepted_risk" }) =>
			routeChanged(loaded(), AppRoute.SecurityFindings({ search }), context).model
		scene(
			{ update: pageUpdate, view },
			given(atStatus({ status: "accepted_risk" })),
			expectView(text("No findings in this status")).toExist(),
			expectView(role("button", { name: "Clear filters" })).toBeAbsent(),
		)
		scene(
			{ update: pageUpdate, view },
			given(atStatus({ q: "exports", status: "accepted_risk" })),
			expectView(text("No findings match these filters")).toExist(),
			expectView(role("button", { name: "Clear filters" })).toExist(),
		)
	})

	test("a run only its target's own list holds re-reads the findings once it finishes", () => {
		const targetId = Schema.decodeSync(SecurityAuditTargetId)(TARGET_IDS.dashboard)
		const ownRuns = runsOf(NOW).runs.filter((run) => run.targetId === TARGET_IDS.dashboard)
		const base = loaded()
		const withoutGlobal = pageUpdate(
			base,
			Message.CompletedFetchRuns({
				key: base.runs.key ?? "",
				result: Result.succeed({
					runs: runsOf(NOW).runs.filter((run) => run.targetId !== TARGET_IDS.dashboard),
				}),
			}),
		).model
		const withOwn = pageUpdate(
			withoutGlobal,
			Message.CompletedFetchTargetRuns({
				targetId,
				key: withoutGlobal.targetRuns[TARGET_IDS.dashboard]?.key ?? "",
				result: Result.succeed({ runs: ownRuns }),
			}),
		).model
		// The live run is only in the target's own list, and still blocks a second run.
		scene(
			{ update: pageUpdate, view },
			given(
				routeChanged(
					withOwn,
					AppRoute.SecurityRuns({ search: { target: TARGET_IDS.dashboard } }),
					context,
				).model,
			),
			expectView(role("button", { name: "Start run" })).toBeDisabled(),
		)
		const polled = pageUpdate(withOwn, Message.TickedPoll({ nowMs: NOW + 15_000 }))
		const answered = pageUpdate(
			polled.model,
			Message.CompletedFetchTargetRuns({
				targetId,
				key: polled.model.targetRuns[TARGET_IDS.dashboard]?.key ?? "",
				result: Result.succeed({
					runs: ownRuns.map((run) => ({ ...run, status: "complete" as const, finishedAt: NOW })),
				}),
			}),
		)
		expect(names(answered.commands)).toEqual(
			expect.arrayContaining(["SecurityApiListFindings", "SecurityApiGetLatestRun"]),
		)
		expect(answered.model.findings[TARGET_IDS.dashboard]?.data._tag).toBe("Refreshing")
	})

	test("with no run live the clock still moves, so this month's spend rolls over", async () => {
		const finished = runsOf(NOW).runs.map((run) => ({
			...run,
			status: "complete" as const,
			finishedAt: NOW,
		}))
		const idle = pageUpdate(
			loaded(),
			Message.CompletedFetchRuns({
				key: loaded().runs.key ?? "",
				result: Result.succeed({ runs: finished }),
			}),
		).model
		expect(runningRuns(idle)).toEqual([])
		expect(spendThisMonth(idle).tokens).toBeGreaterThan(0)
		const nextMonth = Date.UTC(2026, 10, 1)
		const tick = await Effect.runPromise(
			Effect.gen(function* () {
				yield* TestClock.setTime(nextMonth)
				const first = yield* Effect.forkChild(
					Stream.runHead(subscriptions.clock.dependenciesToStream({})),
				)
				yield* TestClock.adjust("1 minute")
				return yield* Fiber.join(first)
			}).pipe(Effect.provide(TestClock.layer())),
		)
		const moved = pageUpdate(idle, Option.getOrThrow(tick)).model
		expect(moved.nowMs).toBe(nextMonth + 60_000)
		expect(spendThisMonth(moved).tokens).toBe(0)
	})
})

/** The org's settings answered on top of `loaded()`. */
const withSettings = (model: Model = loaded()): Model =>
	pageUpdate(
		model,
		Message.CompletedFetchSettings({
			key: model.settings.key ?? "",
			result: Result.succeed(settingsOf(NOW)),
		}),
	).model

describe("spend and models", () => {
	const opened = () => pageUpdate(withSettings(), Message.ClickedSpendAndModels()).model
	const send = (model: Model, message: SpendSettings.Message) =>
		pageUpdate(model, Message.GotSpendSettingsMessage({ message }))
	const pickValidation = (model: Model, value: string) =>
		send(
			model,
			SpendSettings.Message.GotValidationMessage({
				message: Select.Message.SelectedItem({ index: 0, value }),
			}),
		).model

	test("the Overview ranks open leads by severity, an estimate after the proven ones at its level", () => {
		const model = loaded()
		const state = findingsStateOf(model)
		const leads = state._tag === "Ready" ? openLeads(state.findings) : []
		expect(
			leads.map((finding) =>
				finding.verdict === "confirmed"
					? finding.overallSeverity
					: `${finding.estimatedSeverity ?? "no"} estimate`,
			),
		).toEqual([
			"critical",
			"critical",
			"high",
			"high",
			"high",
			"high estimate",
			"medium",
			"medium",
			"medium estimate",
			"low",
		])
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("8 confirmed · 2 to validate")).toExist(),
		)
	})

	test("each run keeps what it reported, even when a later run saw the same finding again", () => {
		const model = loaded(AppRoute.SecurityRuns({ search: {} }))
		const criticalOf = (id: string) => runCountsOf(model, id)?.buckets.critical
		expect([
			criticalOf(RUN_IDS.billing),
			criticalOf(RUN_IDS.billingCancelled),
			criticalOf(RUN_IDS.terraform),
		]).toEqual([1, 1, 0])
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("reached the monthly spend limit")).toExist(),
			expectView(role("columnheader", { name: "Findings" })).toExist(),
			expectView(role("columnheader", { name: "Tokens" })).not.toExist(),
		)
	})

	test("the Overview shows this month's spend against the org's limit", () => {
		scene(
			{ update: pageUpdate, view },
			given(withSettings()),
			expectView(text("of $2,000.00")).toExist(),
			expectView(text(/^\$815\.68 left · resets Nov 1$/)).toExist(),
			expectView(role("button", { name: "Spend & models" })).toExist(),
		)
	})

	test("the form opens on the org's limit and models, and saving sends exactly what it shows", () => {
		const form = opened()
		expect([form.spendSettings.limit.value, form.spendSettings.discovery.value]).toEqual([
			"2000",
			"deepseek/deepseek-v4.1-flash-1017:nitro",
		])
		const raised = send(
			form,
			SpendSettings.Message.GotLimitMessage({
				message: Field.Message.ChangedValue({ value: "2,500" }),
			}),
		).model
		const saved = send(raised, SpendSettings.Message.Submitted())
		expect(
			saved.commands?.find((command) => command.name === "SecurityApiUpdateSettings")?.args,
		).toMatchObject({
			payload: {
				monthlySpendLimitUsd: 2_500,
				discoveryModel: "deepseek/deepseek-v4.1-flash-1017:nitro",
				validationModel: "anthropic/claude-sonnet-5.5",
			},
		})
	})

	test("a comma read as a decimal separator is refused, a thousands separator is not", () => {
		const typedLimit = (value: string) =>
			send(
				opened(),
				SpendSettings.Message.GotLimitMessage({ message: Field.Message.ChangedValue({ value }) }),
			).model.spendSettings
		expect([
			SpendSettings.requestOf(typedLimit("100,50"))?.monthlySpendLimitUsd ?? null,
			SpendSettings.requestOf(typedLimit("1,500"))?.monthlySpendLimitUsd ?? null,
		]).toEqual([null, 1_500])
	})

	test("a settings read that failed says so, and Retry reads it again", () => {
		const model = withSettings()
		const failed = pageUpdate(
			model,
			Message.CompletedFetchSettings({
				key: model.settings.key ?? "",
				result: Result.fail(toLoadFailure(new Error("unavailable"))),
			}),
		).model
		const fresh = loaded()
		const failedFresh = pageUpdate(
			fresh,
			Message.CompletedFetchSettings({
				key: fresh.settings.key ?? "",
				result: Result.fail(toLoadFailure(new Error("unavailable"))),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failedFresh),
			expectView(text("Couldn't load the spend limit")).toExist(),
		)
		expect(names(pageUpdate(failed, Message.ClickedRetry()).commands)).toContain("SecurityApiGetSettings")
	})

	test("verifying on the hunting model is refused before anything is sent", () => {
		const same = pickValidation(opened(), "deepseek/deepseek-v4.1-flash-1017:nitro")
		const submitted = send(same, SpendSettings.Message.Submitted())
		expect(names(submitted.commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(submitted.model),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(text(/^Pick a different model than the one hunting/)).toExist(),
		)
	})

	test("a saved form re-reads the settings and says so", () => {
		const pending = send(opened(), SpendSettings.Message.Submitted()).model
		const saved = send(
			pending,
			SpendSettings.Message.CompletedSave({
				attempt: pending.spendSettings.attempt,
				result: Result.succeed({ ...settingsOf(NOW), monthlySpendLimitUsd: 2_500 }),
			}),
		)
		expect([names(saved.commands).includes("SecurityApiGetSettings"), saved.outMessage?._tag]).toEqual([
			true,
			"RequestedToast",
		])
	})

	test("a member gets no Spend & models control", () => {
		const member = pageUpdate(withSettings(), Message.CompletedReadIsAdmin({ isAdmin: false })).model
		scene(
			{ update: pageUpdate, view },
			given(member),
			expectView(role("button", { name: "Spend & models" })).not.toExist(),
			expectView(text("Edit limit")).not.toExist(),
		)
	})
})

describe("add target", () => {
	const opened = () => pageUpdate(withSettings(), Message.ClickedAddTarget()).model
	const send = (model: Model, message: AddTarget.Message) =>
		pageUpdate(model, Message.GotAddTargetMessage({ message }))
	const pick = (model: Model, value: string) =>
		send(
			model,
			AddTarget.Message.GotRepositoryMessage({
				message: Select.Message.SelectedItem({ index: 1, value }),
			}),
		).model
	const typed = (field: "GotScopeMessage", value: string) =>
		AddTarget.Message[field]({ message: Field.Message.ChangedValue({ value }) })
	const pickModel = (model: Model, field: "GotDiscoveryMessage" | "GotValidationMessage", value: string) =>
		send(model, AddTarget.Message[field]({ message: Select.Message.SelectedItem({ index: 0, value }) }))
			.model

	test("an empty form says what is missing and sends nothing", () => {
		const submitted = send(opened(), AddTarget.Message.Submitted())
		expect(names(submitted.commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(submitted.model),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(text("Pick a repository.")).toExist(),
		)
	})

	test("the picked branch and only the models that differ from the org's are what the create sends", () => {
		const form = pickModel(
			pick(opened(), "acme/api-gateway"),
			"GotDiscoveryMessage",
			"anthropic/claude-haiku-5.5",
		)
		expect([form.addTarget.branch.value, form.addTarget.validation.value]).toEqual([
			"main",
			"anthropic/claude-sonnet-5.5",
		])
		const created = send(form, AddTarget.Message.Submitted())
		const args = created.commands?.find((command) => command.name === "SecurityApiCreateTarget")?.args
		expect(args).toEqual({
			attempt: form.addTarget.attempt,
			payload: {
				repository: "acme/api-gateway",
				branch: "main",
				profile: "deep",
				discoveryModel: "anthropic/claude-haiku-5.5",
			},
		})
	})

	test("verifying on the hunting model is reported under the models and sends nothing", () => {
		const form = pickModel(
			pick(opened(), "acme/api-gateway"),
			"GotValidationMessage",
			"deepseek/deepseek-v4.1-flash-1017:nitro",
		)
		const submitted = send(form, AddTarget.Message.Submitted())
		expect(names(submitted.commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(submitted.model),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(text(/^Pick a different model to verify than to hunt/)).toExist(),
		)
	})

	test("a created target starts its first run", () => {
		const created = send(pick(opened(), "acme/api-gateway"), AddTarget.Message.Submitted()).model
		const target = targetsOf(NOW).targets.find((candidate) => candidate.repository === "acme/api-gateway")
		expect(target).toBeDefined()
		if (target === undefined) return
		const started = send(
			created,
			AddTarget.Message.CompletedCreate({
				attempt: created.addTarget.attempt,
				result: Result.succeed(target),
			}),
		)
		expect(names(started.commands)).toEqual(["SecurityApiStartFirstRun"])
	})

	test("a target that exists is reported under the branch", () => {
		const created = send(pick(opened(), "acme/api-gateway"), AddTarget.Message.Submitted()).model
		const refused = send(
			created,
			AddTarget.Message.CompletedCreate({
				attempt: created.addTarget.attempt,
				result: Result.fail(toLoadFailure(new SecurityAuditTargetExistsError({ message: "exists" }))),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(refused),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(text("This branch is already a target. Open it from the targets table.")).toExist(),
		)
	})

	test("a repository the GitHub App cannot read is reported under the repository", () => {
		const created = send(pick(opened(), "acme/api-gateway"), AddTarget.Message.Submitted()).model
		const refused = send(
			created,
			AddTarget.Message.CompletedCreate({
				attempt: created.addTarget.attempt,
				result: Result.fail(
					toLoadFailure(
						new SecurityAuditRepositoryNotConnectedError({
							message: "no",
							repository: "acme/api-gateway",
						}),
					),
				),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(refused),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(text(/^Maple's GitHub App cannot read this repository/)).toExist(),
		)
	})

	test("a scope path the server refuses is reported under the scope field in the server's words", () => {
		const created = send(pick(opened(), "acme/api-gateway"), AddTarget.Message.Submitted()).model
		const refused = send(
			created,
			AddTarget.Message.CompletedCreate({
				attempt: created.addTarget.attempt,
				result: Result.fail(
					toCreateFailure(
						new ApiRequestValidationError({
							message: "Request payload is invalid (1 problem).",
							param: "scopePaths[0]",
							details: [
								"scopePaths[0]: Expected a repository-relative path like src/api: no '..'",
							],
						}),
					),
				),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(refused),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(text("Expected a repository-relative path like src/api: no '..'")).toExist(),
			expectView(text(/^The request was refused/)).not.toExist(),
		)
	})

	test("a payload the client's own schema refuses names its field too", () => {
		const exit = Schema.decodeExit(SecurityAuditCreateTargetRequest)({
			repository: "acme/api",
			branch: "main",
			scopePaths: ["../etc"],
		})
		const error = exit._tag === "Failure" ? Cause.squash(exit.cause) : null
		const failure = toCreateFailure(error)
		expect(AddTarget.fieldFailure(failure)?.field).toBe("scope")
		expect(failure.message).toMatch(/^Expected a repository-relative path like src\/api/)
	})

	test("the dialog stays open while a create is pending, and an answer for an earlier opening is dropped", () => {
		const pending = send(pick(opened(), "acme/api-gateway"), AddTarget.Message.Submitted()).model
		const escaped = send(
			pending,
			AddTarget.Message.GotDialogMessage({ message: Dialog.Message.PressedEscape() }),
		)
		expect(escaped.model.addTarget).toEqual(pending.addTarget)
		const late = send(
			pending,
			AddTarget.Message.CompletedCreate({
				attempt: pending.addTarget.attempt - 1,
				result: Result.fail(toLoadFailure(new SecurityAuditTargetExistsError({ message: "exists" }))),
			}),
		)
		expect(late.model.addTarget).toEqual(pending.addTarget)
	})

	test("an unsafe or overlong scope path is refused", () => {
		const unsafe = AddTarget.update(AddTarget.init(), typed("GotScopeMessage", "../etc"), []).model
		expect(AddTarget.errorsOf(unsafe).scope).toBeDefined()
		expect(AddTarget.update(unsafe, AddTarget.Message.AddedScopePath(), []).model.scopePaths).toEqual([])
		const long = AddTarget.update(AddTarget.init(), typed("GotScopeMessage", "a".repeat(513)), []).model
		expect(AddTarget.errorsOf(long).scope).toBe("Keep each path under 512 characters.")
	})

	test("the draft path counts toward the 100-path cap", () => {
		const full: AddTarget.Model = {
			...AddTarget.init(),
			scopePaths: Array.from({ length: 100 }, (_, index) => `src/module-${index}`),
		}
		expect(AddTarget.errorsOf(full).scope).toBeUndefined()
		const withDraft = AddTarget.update(full, typed("GotScopeMessage", "src/module-100"), []).model
		expect(AddTarget.errorsOf(withDraft).scope).toBe("At most 100 scope paths.")
		expect(AddTarget.requestOf(withDraft)).toBeNull()
	})
})

describe("retrying failed targets", () => {
	test("keeps the error up while the retry is out, then shows what it answers", () => {
		const entered = init(overview, context).model
		const failed = pageUpdate(
			entered,
			Message.CompletedFetchTargets({
				key: entered.targets.key ?? "",
				result: Result.fail(toLoadFailure(new Error("unreachable"))),
			}),
		).model
		const retried = pageUpdate(failed, Message.ClickedRetry())
		expect(names(retried.commands)).toContain("SecurityApiListTargets")
		expect(retried.model.targets.data._tag).toBe("Failure")
		const answered = pageUpdate(
			retried.model,
			Message.CompletedFetchTargets({
				key: retried.model.targets.key ?? "",
				result: Result.succeed(targetsOf(NOW)),
			}),
		).model
		expect(answered.targets.data._tag).toBe("Success")
	})
})
