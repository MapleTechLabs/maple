import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import {
	DependencyScanPersistenceError,
	type DependencyFindingsResponse,
	type DependencyScanRepositoriesResponse,
	SecurityAuditDisabledError,
	AuditDetectionInvalidError,
	AuditTrailPersistenceError,
	SecurityAuditForbiddenError,
	SecurityAuditTargetExistsError,
} from "@maple/domain/http"
import { SecurityAuditRunId, SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Result, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { AsyncData, type Command } from "foldkit"
import { toLoadFailure } from "@maple/views/data/load-failure"
import type { PageContext } from "../../page/contract"
import * as AddTarget from "../../page/security/kit/add-target"
import * as DependenciesPage from "../../page/security/dependencies/model"
import * as DependenciesUpdate from "../../page/security/dependencies/update"
import * as FindingPage from "../../page/security/finding/model"
import * as FindingUpdate from "../../page/security/finding/update"
import * as RunPage from "../../page/security/run/model"
import * as RunUpdate from "../../page/security/run/update"
import * as TabsPage from "../../page/security/tabs/model"
import * as TabsUpdate from "../../page/security/tabs/update"
import * as AuditLogPage from "../../page/security/audit-log/model"
import * as AuditLogUpdate from "../../page/security/audit-log/update"
import * as DetectionFormPage from "../../page/security/detection-form/model"
import * as DetectionFormUpdate from "../../page/security/detection-form/update"
import * as DetectionsPage from "../../page/security/detections/model"
import * as DetectionsUpdate from "../../page/security/detections/update"
import * as TelemetryPage from "../../page/security/telemetry/model"
import * as TelemetryUpdate from "../../page/security/telemetry/update"
import type { Resources } from "../../platform/resources"
import { AppRoute } from "../../route"
import type { SecurityDependenciesSearch, SecurityDetectionNewSearch } from "../../route/search"
import * as Field from "@maple/views/ui/field"
import * as Menu from "@maple/views/ui/menu"
import * as Select from "@maple/views/ui/select"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
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
import {
	cleanRepositoriesOf,
	FINDING_IDS,
	findingsOf as dependencyFindingsOf,
	largeOrgOf,
	manyRepositoriesOf,
	neverScannedOf,
	noFindings,
	noRepositories,
	PAYMENTS_ID,
	repositoriesOf,
} from "../security-dependencies-fixture"
import { emptyExposureOf, exposureOf, runtimesOf } from "../security-telemetry-fixture"
import { auditEventsOf, noAuditEvents } from "../security-audit-log-fixture"
import {
	detectionDestinationsOf,
	detectionsOf,
	noDetections,
	ON_CALL_ID,
} from "../security-detections-fixture"

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
	"findings-fixed",
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
	"audit-log",
	"audit-log-detail",
	"audit-log-empty",
	"audit-log-filtered-empty",
	"audit-log-member",
	"audit-log-error",
	"audit-log-filtered",
	"detections",
	"detections-empty",
	"detections-member",
	"detections-error",
	"detection-new",
	"detection-new-template",
	"detection-edit",
	"detection-error",
	"runtimes",
	"dependencies",
	"dependencies-finding",
	"dependencies-repository",
	"dependencies-advisories",
	"dependencies-repository-advisories",
	"dependencies-many",
	"dependencies-large",
	"dependencies-large-advisories",
	"dependencies-large-repository",
	"dependencies-repositories",
	"dependencies-clean",
	"dependencies-never-scanned",
	"dependencies-no-github",
	"dependencies-error",
	"dependencies-loading",
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
	!Str.startsWith("SecurityApi")(command.name) && !Str.startsWith("ReadSecurity")(command.name)

const fold = <M, Msg>(
	start: Step<M, Msg>,
	update: (
		model: M,
		message: Msg,
	) => { model: M; commands?: ReadonlyArray<Command.Command<Msg, never, Resources>> },
	messages: ReadonlyArray<(model: M) => Msg>,
): Step<M, Msg> =>
	Arr.reduce(
		messages,
		{ model: start.model, commands: Arr.filter(start.commands, isLocalCommand) } satisfies Step<M, Msg>,
		(step: Step<M, Msg>, toMessage): Step<M, Msg> => {
			const next = update(step.model, toMessage(step.model))
			return {
				model: next.model,
				commands: [...step.commands, ...Arr.filter(next.commands ?? [], isLocalCommand)],
			}
		},
	)

const targetId = (id: string) => Schema.decodeSync(SecurityAuditTargetId)(id)
const runId = (id: string) => Schema.decodeSync(SecurityAuditRunId)(id)

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
		() => M.CompletedReadGrants({ grants: options.member === true ? [] : Policy.allPermissions }),
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
		...Arr.map(
			Rec.values(TARGET_IDS),
			(id) => (model: TabsPage.Model) =>
				M.CompletedFetchTargetRuns({
					targetId: targetId(id),
					key: model.targetRuns[id]?.key ?? "",
					result: Result.succeed({
						runs:
							options.empty === true
								? []
								: Arr.filter(runsOf(nowMs).runs, (run) => run.targetId === id),
					}),
				}),
		),
		...Arr.map(
			Rec.values(TARGET_IDS),
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
		...Arr.map(
			Rec.values(RUN_IDS),
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
			() => R.CompletedReadGrants({ grants: Policy.allPermissions }),
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
			() => F.CompletedReadGrants({ grants: options.member === true ? [] : Policy.allPermissions }),
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

type AuditLogStep = Step<AuditLogPage.Model, AuditLogPage.Message>
const A = AuditLogPage.Message

/** The audit log entered under `search`, as an admin or a member, then sent `answers`. */
const auditLog = (
	nowMs: number,
	options: Readonly<{
		search?: AuditLogPage.Search
		isMember?: boolean
		answers?: ReadonlyArray<(model: AuditLogPage.Model) => AuditLogPage.Message>
	}> = {},
): AuditLogStep => {
	const entered = AuditLogUpdate.init(AppRoute.SecurityAuditLog({ search: options.search ?? {} }), context)
	return fold<AuditLogPage.Model, AuditLogPage.Message>(
		{ model: entered.model, commands: entered.commands ?? [] },
		(model, message) => AuditLogUpdate.update(model, message, context),
		[
			() => A.ReadClock({ nowMs }),
			() =>
				A.CompletedReadGrants({
					orgId: context.orgId,
					grants:
						options.isMember === true ? Policy.grantsOf(["org:engineer"]) : Policy.allPermissions,
				}),
			...(options.answers ?? []),
		],
	)
}

const auditLogPage = (page: AuditLogPage.EventsPage) => (model: AuditLogPage.Model) =>
	A.CompletedFetchFirstPage({ key: model.firstPage.key ?? "", result: Result.succeed(page) })

type DetectionsStep = Step<DetectionsPage.Model, DetectionsPage.Message>
const DT = DetectionsPage.Message

const grantsOf = (isMember: boolean) => (isMember ? Policy.grantsOf(["org:engineer"]) : Policy.allPermissions)

/** The Detections page entered as an admin or a member, then sent `answers`. */
const detections = (
	options: Readonly<{
		isMember?: boolean
		answers?: ReadonlyArray<(model: DetectionsPage.Model) => DetectionsPage.Message>
	}> = {},
): DetectionsStep => {
	const entered = DetectionsUpdate.enter(context, true)
	return fold<DetectionsPage.Model, DetectionsPage.Message>(
		{ model: entered.model, commands: entered.commands ?? [] },
		(model, message) => DetectionsUpdate.update(model, message, context),
		[
			() =>
				DT.CompletedReadGrants({ orgId: context.orgId, grants: grantsOf(options.isMember === true) }),
			...(options.answers ?? []),
		],
	)
}

const detectionsList =
	(list: typeof noDetections) =>
	(model: DetectionsPage.Model): DetectionsPage.Message =>
		DT.CompletedFetchDetections({ key: model.list.key ?? "", result: Result.succeed(list) })

type DetectionFormStep = Step<DetectionFormPage.Model, DetectionFormPage.Message>
const DF = DetectionFormPage.Message

/** The detection editor entered under `search` as an admin, its destinations synced, then sent `answers`. */
const detectionForm = (
	nowMs: number,
	search: SecurityDetectionNewSearch,
	answers: ReadonlyArray<(model: DetectionFormPage.Model) => DetectionFormPage.Message> = [],
): DetectionFormStep => {
	const entered = DetectionFormUpdate.enter(AppRoute.SecurityDetectionNew({ search }), context, true)
	return fold<DetectionFormPage.Model, DetectionFormPage.Message>(
		{ model: entered.model, commands: entered.commands ?? [] },
		(model, message) => DetectionFormUpdate.update(model, message, context),
		[
			() => DF.CompletedReadGrants({ orgId: context.orgId, grants: Policy.allPermissions }),
			() =>
				DF.UpdatedDestinations({
					orgId: context.orgId,
					rows: [...detectionDestinationsOf(context.orgId, nowMs)],
				}),
			...answers,
		],
	)
}

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

type DependenciesStep = Step<DependenciesPage.Model, DependenciesPage.Message>
const D = DependenciesPage.Message

type DependencyAnswers = Readonly<{
	repositories: DependencyScanRepositoriesResponse | "failed"
	findings: DependencyFindingsResponse
}>

const dependencies = (
	nowMs: number,
	answers: DependencyAnswers | null,
	then: ReadonlyArray<(model: DependenciesPage.Model) => DependenciesPage.Message> = [],
	search: SecurityDependenciesSearch = {},
): DependenciesStep => {
	const entered = DependenciesUpdate.init(AppRoute.SecurityDependencies({ search }), context)
	return fold<DependenciesPage.Model, DependenciesPage.Message>(
		{ model: entered.model, commands: entered.commands ?? [] },
		(model, message) => DependenciesUpdate.update(model, message, context),
		[
			() => D.ReadClock({ nowMs }),
			() => D.CompletedReadGrants({ grants: Policy.allPermissions }),
			...(answers === null
				? []
				: [
						(model: DependenciesPage.Model) =>
							D.CompletedFetchRepositories({
								key: model.repositories.key ?? "",
								result:
									answers.repositories === "failed"
										? Result.fail(
												toLoadFailure(
													new DependencyScanPersistenceError({
														message: "Dependency scans are unavailable",
													}),
												),
											)
										: Result.succeed(answers.repositories),
							}),
						(model: DependenciesPage.Model) =>
							D.CompletedFetchFindings({
								key: model.findings.key ?? "",
								result: Result.succeed(answers.findings),
							}),
					]),
			...then,
		],
	)
}

export type Built =
	| Readonly<{ _tag: "Tabs"; step: TabsStep }>
	| Readonly<{ _tag: "Run"; step: RunStep }>
	| Readonly<{ _tag: "Finding"; step: FindingStep }>
	| Readonly<{ _tag: "Telemetry"; step: TelemetryStep }>
	| Readonly<{ _tag: "AuditLog"; step: AuditLogStep }>
	| Readonly<{ _tag: "Detections"; step: DetectionsStep }>
	| Readonly<{ _tag: "DetectionForm"; step: DetectionFormStep }>
	| Readonly<{ _tag: "Dependencies"; step: DependenciesStep }>

const overviewRoute = AppRoute.SecurityCode()

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
			return { _tag: "Tabs", step: tabs(AppRoute.SecurityCodeFindings({ search: {} }), nowMs) }
		case "findings-fixed":
			return {
				_tag: "Tabs",
				step: tabs(AppRoute.SecurityCodeFindings({ search: { status: "fixed" } }), nowMs),
			}
		case "findings-member":
			return {
				_tag: "Tabs",
				step: tabs(AppRoute.SecurityCodeFindings({ search: {} }), nowMs, { member: true }),
			}
		case "runs":
			return { _tag: "Tabs", step: tabs(AppRoute.SecurityCodeRuns({ search: {} }), nowMs) }
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
		case "audit-log":
			return {
				_tag: "AuditLog",
				step: auditLog(nowMs, { answers: [auditLogPage(auditEventsOf(nowMs))] }),
			}
		case "audit-log-detail":
			return {
				_tag: "AuditLog",
				step: auditLog(nowMs, {
					answers: [
						auditLogPage(auditEventsOf(nowMs, false)),
						(model) =>
							A.ToggledEvent({
								id: AsyncData.matchData(model.firstPage.data, {
									onEmpty: () => "",
									onFailure: () => "",
									onData: (page) => page.events[0]?.id ?? "",
								}),
							}),
					],
				}),
			}
		case "audit-log-empty":
			return { _tag: "AuditLog", step: auditLog(nowMs, { answers: [auditLogPage(noAuditEvents)] }) }
		case "audit-log-filtered-empty":
			return {
				_tag: "AuditLog",
				step: auditLog(nowMs, {
					search: { category: "billing", outcome: "denied" },
					answers: [auditLogPage(noAuditEvents)],
				}),
			}
		case "audit-log-member":
			return { _tag: "AuditLog", step: auditLog(nowMs, { isMember: true }) }
		case "audit-log-error":
			return {
				_tag: "AuditLog",
				step: auditLog(nowMs, {
					answers: [
						(model) =>
							A.CompletedFetchFirstPage({
								key: model.firstPage.key ?? "",
								result: Result.fail(
									toLoadFailure(
										new AuditTrailPersistenceError({
											message: "The audit trail could not be read",
										}),
									),
								),
							}),
					],
				}),
			}
		case "audit-log-filtered":
			return {
				_tag: "AuditLog",
				step: auditLog(nowMs, {
					search: { provider: "vercel", category: "credential" },
					answers: [
						auditLogPage({
							events: Arr.filter(
								auditEventsOf(nowMs).events,
								(event) => event.provider === "vercel" && event.category === "credential",
							),
							nextCursor: null,
						}),
					],
				}),
			}
		case "detections":
			return {
				_tag: "Detections",
				step: detections({ answers: [detectionsList(detectionsOf(nowMs))] }),
			}
		case "detections-empty":
			return { _tag: "Detections", step: detections({ answers: [detectionsList(noDetections)] }) }
		case "detections-member":
			return { _tag: "Detections", step: detections({ isMember: true }) }
		case "detections-error":
			return {
				_tag: "Detections",
				step: detections({
					answers: [
						(model) =>
							DT.CompletedFetchDetections({
								key: model.list.key ?? "",
								result: Result.fail(
									toLoadFailure(
										new AuditTrailPersistenceError({
											message: "The audit trail could not be read",
										}),
									),
								),
							}),
					],
				}),
			}
		case "detection-new":
			return { _tag: "DetectionForm", step: detectionForm(nowMs, {}) }
		case "detection-new-template":
			return { _tag: "DetectionForm", step: detectionForm(nowMs, { template: "sign_in" }) }
		case "detection-edit": {
			const list = detectionsOf(nowMs)
			return {
				_tag: "DetectionForm",
				step: detectionForm(nowMs, { detectionId: list.detections[1]?.id }, [
					(model) =>
						DF.CompletedFetchExisting({
							key: model.existing.key ?? "",
							result: Result.succeed(list),
						}),
				]),
			}
		}
		case "detection-error":
			return {
				_tag: "DetectionForm",
				step: detectionForm(nowMs, { template: "refused" }, [
					() =>
						DF.GotDestinationMenuMessage({
							message: Menu.Message.ClickedItem({
								index: 1,
								item: { kind: "Item", value: ON_CALL_ID },
							}),
						}),
					() => DF.ClickedSave(),
					() =>
						DF.CompletedSave({
							result: Result.fail(
								toLoadFailure(
									new AuditDetectionInvalidError({
										message:
											'Another alert rule is already named "Burst of refused requests".',
									}),
								),
							),
						}),
				]),
			}
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
		case "dependencies":
			return { _tag: "Dependencies", step: populatedDependencies(nowMs) }
		case "dependencies-finding":
			return {
				_tag: "Dependencies",
				step: populatedDependencies(nowMs, [
					() => D.ClickedFinding({ findingId: FINDING_IDS.axios }),
				]),
			}
		case "dependencies-repository":
			return { _tag: "Dependencies", step: populatedDependencies(nowMs, [], { repo: PAYMENTS_ID }) }
		case "dependencies-advisories":
			return { _tag: "Dependencies", step: populatedDependencies(nowMs, [], { view: "advisories" }) }
		case "dependencies-repository-advisories":
			return {
				_tag: "Dependencies",
				step: populatedDependencies(nowMs, [], { repo: PAYMENTS_ID, view: "advisories" }),
			}
		case "dependencies-many":
			return { _tag: "Dependencies", step: dependencies(nowMs, manyRepositoriesOf(nowMs)) }
		case "dependencies-large":
			return { _tag: "Dependencies", step: dependencies(nowMs, largeOrgOf(nowMs, 300)) }
		case "dependencies-large-repository":
			// acme/notifications-188, the riskiest of the 300.
			return {
				_tag: "Dependencies",
				step: dependencies(nowMs, largeOrgOf(nowMs, 300), [], {
					repo: "a0000000-0000-4000-8000-0000000000bc",
				}),
			}
		case "dependencies-large-advisories":
			return {
				_tag: "Dependencies",
				step: dependencies(nowMs, largeOrgOf(nowMs, 300), [], { view: "advisories" }),
			}
		case "dependencies-repositories":
			return { _tag: "Dependencies", step: populatedDependencies(nowMs, [], { view: "repositories" }) }
		case "dependencies-clean":
			return {
				_tag: "Dependencies",
				step: dependencies(nowMs, {
					repositories: cleanRepositoriesOf(nowMs),
					findings: {
						...dependencyFindingsOf(nowMs),
						findings: Arr.filter(
							dependencyFindingsOf(nowMs).findings,
							(finding) => finding.status !== "open",
						),
					},
				}),
			}
		case "dependencies-never-scanned":
			return {
				_tag: "Dependencies",
				step: dependencies(nowMs, { repositories: neverScannedOf(nowMs), findings: noFindings }),
			}
		case "dependencies-no-github":
			return {
				_tag: "Dependencies",
				step: dependencies(nowMs, { repositories: noRepositories, findings: noFindings }),
			}
		case "dependencies-error":
			return {
				_tag: "Dependencies",
				step: dependencies(nowMs, { repositories: "failed", findings: noFindings }),
			}
		case "dependencies-loading":
			return { _tag: "Dependencies", step: dependencies(nowMs, null) }
	}
}

const populatedDependencies = (
	nowMs: number,
	then: ReadonlyArray<(model: DependenciesPage.Model) => DependenciesPage.Message> = [],
	search: SecurityDependenciesSearch = {},
): DependenciesStep =>
	dependencies(
		nowMs,
		{ repositories: repositoriesOf(nowMs), findings: dependencyFindingsOf(nowMs) },
		then,
		search,
	)
