import { OrgId } from "@maple/domain"
import {
	SecurityAuditDisabledError,
	SecurityAuditForbiddenError,
	SecurityAuditTargetExistsError,
} from "@maple/domain/http"
import { SecurityAuditRunId, SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Result, Schema } from "effect"
import type { Command } from "foldkit"
import { toLoadFailure } from "../../data/load-failure"
import type { PageContext } from "../../page/contract"
import * as AddTarget from "../../page/security/kit/add-target"
import * as FindingPage from "../../page/security/finding/model"
import * as FindingUpdate from "../../page/security/finding/update"
import * as RunPage from "../../page/security/run/model"
import * as RunUpdate from "../../page/security/run/update"
import * as TabsPage from "../../page/security/tabs/model"
import * as TabsUpdate from "../../page/security/tabs/update"
import * as TelemetryPage from "../../page/security/telemetry/model"
import * as TelemetryUpdate from "../../page/security/telemetry/update"
import type { Resources } from "../../platform/resources"
import { AppRoute } from "../../route"
import * as Field from "../../ui/field"
import * as Select from "../../ui/select"
import * as ToggleGroup from "../../ui/toggle-group"
import {
	DEEP_RUN_IDS,
	DEEP_TARGET_ID,
	eventsOf,
	findingsOf,
	githubStatusOf,
	labTargetsOf,
	RUN_IDS,
	runDetailOf,
	runFindingsOf,
	runsOf,
	settingsOf,
	TARGET_IDS,
	targetsOf,
	unitsOf,
} from "../security-fixture"
import { emptyExposureOf, exposureOf, runtimesOf } from "../security-telemetry-fixture"

// Every Security Center state the lab renders, built by sending each page the fixture answers its
// own requests would get. API Commands are dropped; dialog and select Commands still run.

export const SCENARIOS = [
	"overview",
	"empty",
	"not-enabled",
	"add-target",
	"add-target-invalid",
	"add-target-exists",
	"spend-and-models",
	"findings",
	"findings-member",
	"runs",
	"run-live",
	"run-incomplete",
	"run-failed",
	"run-cancelled",
	"run-deep-incomplete",
	"run-deep-live",
	"finding",
	"finding-triage",
	"finding-member",
	"finding-lead",
	"exposure",
	"exposure-empty",
	"runtimes",
] as const
export const Scenario = Schema.Literals(SCENARIOS)
export type Scenario = typeof Scenario.Type

export const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

type Step<M, Msg> = Readonly<{ model: M; commands: ReadonlyArray<Command.Command<Msg, never, Resources>> }>

/** Commands that leave the page (API, session, clock) are the lab's to answer, not the browser's. */
export const isLocalCommand = (command: { readonly name: string }): boolean =>
	!command.name.startsWith("SecurityApi") && !command.name.startsWith("ReadSecurity")

const fold = <M, Msg>(
	start: Step<M, Msg>,
	update: (
		model: M,
		message: Msg,
	) => { model: M; commands?: ReadonlyArray<Command.Command<Msg, never, Resources>> },
	messages: ReadonlyArray<(model: M) => Msg>,
): Step<M, Msg> =>
	messages.reduce<Step<M, Msg>>(
		(step, toMessage) => {
			const next = update(step.model, toMessage(step.model))
			return {
				model: next.model,
				commands: [...step.commands, ...(next.commands ?? []).filter(isLocalCommand)],
			}
		},
		{ model: start.model, commands: start.commands.filter(isLocalCommand) },
	)

const targetId = (id: string) => Schema.decodeSync(SecurityAuditTargetId)(id)
const runId = (id: string) => Schema.decodeSync(SecurityAuditRunId)(id)

// TABS

type TabsStep = Step<TabsPage.Model, TabsPage.Message>
const tabsUpdate = (model: TabsPage.Model, message: TabsPage.Message) =>
	TabsUpdate.update(model, message, context)
const M = TabsPage.Message

const tabs = (
	route: Parameters<typeof TabsUpdate.init>[0],
	nowMs: number,
	options: Readonly<{ empty?: boolean; disabled?: boolean; member?: boolean }> = {},
): TabsStep => {
	const entered = TabsUpdate.init(route, context)
	const targets = options.empty === true ? { targets: [] } : targetsOf(nowMs)
	const answers: ReadonlyArray<(model: TabsPage.Model) => TabsPage.Message> = [
		() => M.ReadClock({ nowMs }),
		() => M.CompletedReadIsAdmin({ isAdmin: options.member !== true }),
		(model) =>
			M.CompletedFetchTargets({
				key: model.targets.key ?? "",
				result:
					options.disabled === true
						? Result.fail(
								toLoadFailure(
									new SecurityAuditDisabledError({
										message: "Security audits are not enabled",
									}),
								),
							)
						: Result.succeed(targets),
			}),
		(model) =>
			M.CompletedFetchRuns({
				key: model.runs.key ?? "",
				result: Result.succeed(options.empty === true ? { runs: [] } : runsOf(nowMs)),
			}),
		(model) =>
			M.CompletedFetchSettings({
				key: model.settings.key ?? "",
				result: Result.succeed(settingsOf(nowMs)),
			}),
		(model) =>
			M.CompletedFetchGithubStatus({
				key: model.githubStatus.key ?? "",
				result: Result.succeed(githubStatusOf()),
			}),
		...Object.values(TARGET_IDS).map(
			(id) => (model: TabsPage.Model) =>
				M.CompletedFetchTargetRuns({
					targetId: targetId(id),
					key: model.targetRuns[id]?.key ?? "",
					result: Result.succeed({
						runs:
							options.empty === true
								? []
								: runsOf(nowMs).runs.filter((run) => run.targetId === id),
					}),
				}),
		),
		...Object.values(TARGET_IDS).map(
			(id) => (model: TabsPage.Model) =>
				M.CompletedFetchFindings({
					targetId: targetId(id),
					key: model.findings[id]?.key ?? "",
					result:
						options.member === true
							? Result.fail(
									toLoadFailure(
										new SecurityAuditForbiddenError({ message: "Admins only" }),
									),
								)
							: Result.succeed(findingsOf(nowMs, id)),
				}),
		),
		...Object.values(RUN_IDS).map(
			(id) => (model: TabsPage.Model) =>
				M.CompletedFetchLatestRun({
					runId: runId(id),
					key: model.latestRuns[id]?.key ?? "",
					result: Result.succeed(runDetailOf(nowMs, id)),
				}),
		),
	]
	return fold<TabsPage.Model, TabsPage.Message>(
		{ model: entered.model, commands: entered.commands ?? [] },
		tabsUpdate,
		answers,
	)
}

const addTarget = (message: AddTarget.Message) => () => M.GotAddTargetMessage({ message })

const withDialog = (
	step: TabsStep,
	extra: ReadonlyArray<(model: TabsPage.Model) => TabsPage.Message>,
): TabsStep => fold(step, tabsUpdate, [() => M.ClickedAddTarget(), ...extra])

// RUN

type RunStep = Step<RunPage.Model, RunPage.Message>
const R = RunPage.Message

const run = (id: string, nowMs: number): RunStep => {
	const entered = RunUpdate.init(AppRoute.SecurityRun({ runId: runId(id) }), context)
	const detail = runDetailOf(nowMs, id)
	return fold<RunPage.Model, RunPage.Message>(
		{ model: entered.model, commands: entered.commands ?? [] },
		(model, message) => RunUpdate.update(model, message, context),
		[
			() => R.ReadClock({ nowMs }),
			() => R.CompletedReadIsAdmin({ isAdmin: true }),
			(model) => R.CompletedFetchRun({ key: model.run.key ?? "", result: Result.succeed(detail) }),
			(model) =>
				R.CompletedFetchEvents({
					key: model.events.key ?? "",
					result: Result.succeed(eventsOf(nowMs, id)),
				}),
			(model) =>
				R.CompletedFetchUnits({
					key: model.units.key ?? "",
					result: Result.succeed(detail.unitTotal === 0 ? { units: [] } : unitsOf(id)),
				}),
			(model) =>
				R.CompletedFetchTargets({
					key: model.targets.key ?? "",
					result: Result.succeed(labTargetsOf(nowMs)),
				}),
			(model) =>
				R.CompletedFetchFindings({
					key: model.findings.key ?? "",
					result: Result.succeed(runFindingsOf(nowMs, id)),
				}),
		],
	)
}

// FINDING

type FindingStep = Step<FindingPage.Model, FindingPage.Message>
const F = FindingPage.Message

const finding = (
	nowMs: number,
	options: Readonly<{ member?: boolean; triage?: boolean; lead?: boolean }> = {},
): FindingStep => {
	// The lead is one the deep run left to validate; the default is a confirmed critical.
	const owner = options.lead === true ? DEEP_TARGET_ID : TARGET_IDS.gateway
	const entered = FindingUpdate.init(
		AppRoute.SecurityFinding({
			targetId: targetId(owner),
			fingerprint: options.lead === true ? "export-retry-c3d2" : "exports-tenant-body-8b9e",
		}),
		context,
	)
	return fold<FindingPage.Model, FindingPage.Message>(
		{ model: entered.model, commands: entered.commands ?? [] },
		(model, message) => FindingUpdate.update(model, message, context),
		[
			() => F.ReadClock({ nowMs }),
			() => F.CompletedReadIsAdmin({ isAdmin: options.member !== true }),
			(model) =>
				F.CompletedFetchFindings({
					key: model.findings.key ?? "",
					result:
						options.member === true
							? Result.fail(
									toLoadFailure(
										new SecurityAuditForbiddenError({ message: "Admins only" }),
									),
								)
							: Result.succeed(findingsOf(nowMs, owner)),
				}),
			(model) =>
				F.CompletedFetchTargets({
					key: model.targets.key ?? "",
					result: Result.succeed(labTargetsOf(nowMs)),
				}),
			...(options.triage === true
				? [
						() =>
							F.GotTriageMessage({
								message: ToggleGroup.Message.ClickedItem({ value: "dismissed", index: 1 }),
							}),
						() => F.SubmittedTriage(),
					]
				: []),
		],
	)
}

// TELEMETRY

type TelemetryStep = Step<TelemetryPage.Model, TelemetryPage.Message>
const T = TelemetryPage.Message

const telemetry = (
	route: Parameters<typeof TelemetryUpdate.init>[0],
	nowMs: number,
	answer: (model: TelemetryPage.Model) => TelemetryPage.Message,
): TelemetryStep => {
	const entered = TelemetryUpdate.init(route, context)
	return fold<TelemetryPage.Model, TelemetryPage.Message>(
		{ model: entered.model, commands: entered.commands ?? [] },
		(model, message) => TelemetryUpdate.update(model, message, context),
		[() => T.ReadClock({ nowMs }), answer],
	)
}

const exposure = (nowMs: number, data: TelemetryPage.Exposure): TelemetryStep =>
	telemetry(AppRoute.SecurityExposure(), nowMs, (model) =>
		T.CompletedFetchExposure({ key: model.exposure.key ?? "", result: Result.succeed(data) }),
	)

// SCENARIOS

export type Built =
	| Readonly<{ _tag: "Tabs"; step: TabsStep }>
	| Readonly<{ _tag: "Run"; step: RunStep }>
	| Readonly<{ _tag: "Finding"; step: FindingStep }>
	| Readonly<{ _tag: "Telemetry"; step: TelemetryStep }>

const overviewRoute = AppRoute.Security()

export const build = (scenario: Scenario, nowMs: number): Built => {
	switch (scenario) {
		case "overview":
			return { _tag: "Tabs", step: tabs(overviewRoute, nowMs) }
		case "empty":
			return { _tag: "Tabs", step: tabs(overviewRoute, nowMs, { empty: true }) }
		case "not-enabled":
			return { _tag: "Tabs", step: tabs(overviewRoute, nowMs, { disabled: true }) }
		case "add-target":
			return {
				_tag: "Tabs",
				step: withDialog(tabs(overviewRoute, nowMs), [
					addTarget(
						AddTarget.Message.GotRepositoryMessage({
							message: Select.Message.SelectedItem({ index: 0, value: "acme/payments-api" }),
						}),
					),
					addTarget(
						AddTarget.Message.GotScopeMessage({
							message: Field.Message.ChangedValue({ value: "services/payments/src" }),
						}),
					),
					addTarget(AddTarget.Message.AddedScopePath()),
					addTarget(
						AddTarget.Message.GotScopeMessage({
							message: Field.Message.ChangedValue({ value: "packages/auth" }),
						}),
					),
					addTarget(AddTarget.Message.AddedScopePath()),
				]),
			}
		case "add-target-invalid":
			return {
				_tag: "Tabs",
				step: withDialog(tabs(overviewRoute, nowMs), [
					addTarget(
						AddTarget.Message.GotScopeMessage({
							message: Field.Message.ChangedValue({ value: "../secrets" }),
						}),
					),
					// Verifying on the hunting model is refused before the request.
					addTarget(
						AddTarget.Message.GotValidationMessage({
							message: Select.Message.SelectedItem({
								index: 0,
								value: "deepseek/deepseek-v4.1-flash-1017:nitro",
							}),
						}),
					),
					addTarget(AddTarget.Message.Submitted()),
				]),
			}
		case "add-target-exists":
			return {
				_tag: "Tabs",
				step: withDialog(tabs(overviewRoute, nowMs), [
					addTarget(
						AddTarget.Message.GotRepositoryMessage({
							message: Select.Message.SelectedItem({ index: 1, value: "acme/api-gateway" }),
						}),
					),
					addTarget(AddTarget.Message.Submitted()),
					(model) =>
						M.GotAddTargetMessage({
							message: AddTarget.Message.CompletedCreate({
								attempt: model.addTarget.attempt,
								result: Result.fail(
									toLoadFailure(new SecurityAuditTargetExistsError({ message: "exists" })),
								),
							}),
						}),
				]),
			}
		case "spend-and-models":
			return {
				_tag: "Tabs",
				step: fold(tabs(overviewRoute, nowMs), tabsUpdate, [() => M.ClickedSpendAndModels()]),
			}
		case "findings":
			return { _tag: "Tabs", step: tabs(AppRoute.SecurityFindings({ search: {} }), nowMs) }
		case "findings-member":
			return {
				_tag: "Tabs",
				step: tabs(AppRoute.SecurityFindings({ search: {} }), nowMs, { member: true }),
			}
		case "runs":
			return { _tag: "Tabs", step: tabs(AppRoute.SecurityRuns({ search: {} }), nowMs) }
		case "run-live":
			return { _tag: "Run", step: run(RUN_IDS.dashboard, nowMs) }
		case "run-incomplete":
			return { _tag: "Run", step: run(RUN_IDS.billing, nowMs) }
		case "run-failed":
			return { _tag: "Run", step: run(RUN_IDS.terraform, nowMs) }
		case "run-cancelled":
			return { _tag: "Run", step: run(RUN_IDS.billingCancelled, nowMs) }
		case "run-deep-incomplete":
			return { _tag: "Run", step: run(DEEP_RUN_IDS.incomplete, nowMs) }
		case "run-deep-live":
			return { _tag: "Run", step: run(DEEP_RUN_IDS.live, nowMs) }
		case "finding":
			return { _tag: "Finding", step: finding(nowMs) }
		case "finding-triage":
			return { _tag: "Finding", step: finding(nowMs, { triage: true }) }
		case "finding-member":
			return { _tag: "Finding", step: finding(nowMs, { member: true }) }
		case "finding-lead":
			return { _tag: "Finding", step: finding(nowMs, { lead: true }) }
		case "exposure":
			return { _tag: "Telemetry", step: exposure(nowMs, exposureOf(nowMs)) }
		case "exposure-empty":
			return { _tag: "Telemetry", step: exposure(nowMs, emptyExposureOf()) }
		case "runtimes":
			return {
				_tag: "Telemetry",
				step: telemetry(AppRoute.SecurityRuntimes(), nowMs, (model) =>
					T.CompletedFetchRuntimes({
						key: model.runtimes.key ?? "",
						result: Result.succeed(runtimesOf(nowMs)),
					}),
				),
			}
	}
}
