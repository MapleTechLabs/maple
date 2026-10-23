import { OrgId } from "@maple/domain"
import {
	SecurityAuditDisabledError,
	SecurityAuditForbiddenError,
	SecurityAuditRepositoryNotConnectedError,
	SecurityAuditTargetExistsError,
} from "@maple/domain/http"
import { SecurityAuditRunId, SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import {
	findingsOf,
	githubStatusOf,
	RUN_IDS,
	runDetailOf,
	runsOf,
	TARGET_IDS,
	targetsOf,
} from "../../../lab/security-fixture"
import { AppRoute } from "../../../route"
import * as Dialog from "../../../ui/dialog"
import * as Field from "../../../ui/field"
import * as Select from "../../../ui/select"
import type { PageContext } from "../../contract"
import * as AddTarget from "../kit/add-target"
import {
	filteredFindings,
	findingsStateOf,
	groupFindings,
	latestRunFor,
	runningRuns,
	spendThisMonth,
} from "./derive"
import { Message, type Model } from "./model"
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
		const groupsOf = (rejected: boolean) =>
			groupFindings(filteredFindings(findings, rejected ? { rejected } : {}, "")).map(
				(entry) => entry.group,
			)
		expect(groupsOf(false)).toEqual(["confirmed", "needs_validation"])
		expect(groupsOf(true)).toEqual(["confirmed", "needs_validation", "rejected"])
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
			expectView(text("Failed to load findings")).toExist(),
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
			expectView(text(/excludes 1 unpriced run · newest 50 runs per target only$/)).toExist(),
		)
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
})

describe("add target", () => {
	const opened = () => pageUpdate(loaded(), Message.ClickedAddTarget()).model
	const send = (model: Model, message: AddTarget.Message) =>
		pageUpdate(model, Message.GotAddTargetMessage({ message }))
	const pick = (model: Model, value: string) =>
		send(
			model,
			AddTarget.Message.GotRepositoryMessage({
				message: Select.Message.SelectedItem({ index: 1, value }),
			}),
		).model
	const typed = (field: "GotScopeMessage" | "GotBudgetMessage", value: string) =>
		AddTarget.Message[field]({ message: Field.Message.ChangedValue({ value }) })

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

	test("the picked repository's branch and a custom budget are what the create sends", () => {
		const form = send(pick(opened(), "acme/api-gateway"), typed("GotBudgetMessage", "1500")).model
		expect(form.addTarget.branch.value).toBe("main")
		const created = send(form, AddTarget.Message.Submitted())
		expect(
			created.commands?.find((command) => command.name === "SecurityApiCreateTarget")?.args,
		).toMatchObject({
			payload: { repository: "acme/api-gateway", branch: "main", profile: "deep", budgetPerRun: 1500 },
		})
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
