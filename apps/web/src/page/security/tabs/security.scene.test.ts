import { OrgId } from "@maple/domain"
import {
	SecurityAuditDisabledError,
	SecurityAuditForbiddenError,
	SecurityAuditTargetExistsError,
} from "@maple/domain/http"
import { SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Result, Schema } from "effect"
import { expect as expectView, given, scene, text, withViewInputs } from "foldkit/scene"
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
import * as Field from "../../../ui/field"
import * as Select from "../../../ui/select"
import type { PageContext } from "../../contract"
import * as AddTarget from "../kit/add-target"
import { filteredFindings, findingsStateOf, groupFindings } from "./derive"
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

	test("the targets answer reads each target's findings and its latest run", () => {
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
})

describe("add target", () => {
	const opened = () => pageUpdate(loaded(), Message.ClickedAddTarget()).model
	const send = (model: Model, message: AddTarget.Message) =>
		pageUpdate(model, Message.GotAddTargetMessage({ message }))

	test("an empty form says what is missing and sends nothing", () => {
		const submitted = send(opened(), AddTarget.Message.Submitted())
		expect(names(submitted.commands)).toEqual([])
		expect(AddTarget.errorsOf(submitted.model.addTarget).repository).toBe("Pick a repository.")
	})

	test("a picked repository fills its branch and the form creates the target, then starts its first run", () => {
		const form = AddTarget.update(
			AddTarget.open(AddTarget.init()).model,
			AddTarget.Message.GotRepositoryMessage({
				message: Select.Message.SelectedItem({ index: 1, value: "acme/api-gateway" }),
			}),
			githubStatusOf().repositories,
		).model
		expect(form.branch.value).toBe("main")
		const created = AddTarget.update(form, AddTarget.Message.Submitted(), [])
		expect(names(created.commands)).toEqual(["SecurityApiCreateTarget"])
		expect(AddTarget.requestOf(form)).toEqual({
			repository: "acme/api-gateway",
			branch: "main",
			profile: "deep",
			budgetPerRun: 400,
		})
		const target = targetsOf(NOW).targets[0]
		if (target === undefined) throw new Error("fixture has no target")
		const started = AddTarget.update(
			created.model,
			AddTarget.Message.CompletedCreate({ result: Result.succeed(target) }),
			[],
		)
		expect(names(started.commands)).toEqual(["SecurityApiStartFirstRun"])
	})

	test("a target that exists is reported next to the branch", () => {
		const failure = toLoadFailure(new SecurityAuditTargetExistsError({ message: "exists" }))
		expect(AddTarget.fieldFailure(failure)?.field).toBe("branch")
	})

	test("an unsafe scope path is refused", () => {
		const form = AddTarget.update(
			AddTarget.init(),
			AddTarget.Message.GotScopeMessage({ message: Field.Message.ChangedValue({ value: "../etc" }) }),
			[],
		).model
		expect(AddTarget.errorsOf(form).scope).toBeDefined()
		expect(AddTarget.update(form, AddTarget.Message.AddedScopePath(), []).model.scopePaths).toEqual([])
	})
})
