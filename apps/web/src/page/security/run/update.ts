import * as Policy from "@maple/domain/policy"
import type { SecurityAuditEvent } from "@maple/domain/http"
import type { SecurityAuditFindingStatus } from "@maple/domain/security-audit"
import { Option, Result, Array as Arr, String as Str } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import { isClerkAuthEnabled } from "../../../platform/auth-mode"
import { AppRoute, hrefOf } from "../../../route"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { chainAll, slotStep } from "../../kit/keyed-step"
import { FINDING_STATUS_LABEL, isLive } from "../kit/format"
import {
	currentTriageOf,
	isTriageChange,
	pickedTriageOf,
	reasonErrorOf,
	runTriageChoices,
} from "../kit/triage-form"
import {
	CancelRun,
	EVENTS_PAGE,
	FetchEvents,
	FetchOlderEvents,
	FetchRun,
	FetchRunFindings,
	FetchRunTargets,
	FetchUnits,
	ReadRunClock,
	ReadRunGrants,
	ParseSecurityReports,
	StartAnotherRun,
	UpdateRunFindingStatus,
} from "./command"
import {
	eventsOf,
	isDetailsOpenByDefault,
	isTriageable,
	mergeEvents,
	openFindingOf,
	resultsOf,
	runOf,
} from "./derive"
import { Message, type Model } from "./model"

type Return = PageReturn<Model, Message>

export type SecurityRunRoute = Extract<AppRoute, { readonly _tag: "SecurityRun" }>

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

const keyOf = (context: PageContext, operation: string, input: unknown) =>
	requestKey(context.orgId, `securityAudit.${operation}`, input)

const readRun = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	slotStep(
		model,
		model.run,
		(run) => ({ run }),
		keyOf(context, "getRun", { runId: model.runId }),
		mode,
		(key) => FetchRun({ key, runId: model.runId }),
	)

const readEvents = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	slotStep(
		model,
		model.events,
		(events) => ({ events }),
		keyOf(context, "listRunEvents", { runId: model.runId }),
		mode,
		(key) => FetchEvents({ key, runId: model.runId }),
	)

const readUnits = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	slotStep(
		model,
		model.units,
		(units) => ({ units }),
		keyOf(context, "listRunUnits", { runId: model.runId }),
		mode,
		(key) => FetchUnits({ key, runId: model.runId }),
	)

const readTargets = (model: Model, context: PageContext): Return =>
	slotStep(
		model,
		model.targets,
		(targets) => ({ targets }),
		keyOf(context, "listTargets", {}),
		"Load",
		(key) => FetchRunTargets({ key }),
	)

/** What this run reported, from its own snapshot: a later run seeing them again changes nothing. */
const readFindings = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	slotStep(
		model,
		model.findings,
		(findings) => ({ findings }),
		keyOf(context, "listRunFindings", { runId: model.runId }),
		mode,
		(key) => FetchRunFindings({ key, runId: model.runId }),
	)

/** The control starts on the finding's own status. */
const initTriage = (status: SecurityAuditFindingStatus = "open"): ToggleGroup.Model =>
	ToggleGroup.init({ label: "Status", values: [currentTriageOf(status)] })

/** The control shows the finding's status until someone picks another; a second click keeps it. */
const triageStep = (model: Model, message: ToggleGroup.Message): Return => {
	const step = ToggleGroup.update(model.triage, message)
	const finding = openFindingOf(model)
	const current = finding === null ? "open" : pickedTriageOf(model.triage, finding.status)
	const values = step.model.values.length === 0 ? [current] : step.model.values
	return {
		model: { ...model, triage: { ...step.model, values }, isTriageSubmitted: false },
		commands: Command.mapMessages(step.commands ?? [], (inner) =>
			Message.GotTriageMessage({ message: inner }),
		),
	}
}

export const init = (route: SecurityRunRoute, context: PageContext): Return => {
	const model: Model = {
		runId: route.runId,
		nowMs: 0,
		grants: isClerkAuthEnabled ? [] : Policy.allPermissions,
		run: Keyed.idle(),
		events: Keyed.idle(),
		eventLog: [],
		isLoadingOlder: false,
		gapUntil: null,
		queuedGaps: [],
		olderCursor: null,
		hasMoreOlder: true,
		units: Keyed.idle(),
		targets: Keyed.idle(),
		findings: Keyed.idle(),
		severity: null,
		collapsed: ["rejected"],
		openFingerprint: null,
		findingDialog: Dialog.init("security-run-finding", "sheet"),
		triage: initTriage(),
		reason: Field.init(),
		isTriageSubmitted: false,
		savingFingerprint: null,
		isDetailsOpen: null,
		unitFilter: "all",
		eventFilter: "all",
		isLedgerOpen: false,
		busy: null,
		cancelDialog: Dialog.init("security-cancel-run", "alert-dialog"),
		reportDialog: Dialog.init("security-run-report", "sheet"),
		report: "report",
		parsedReports: [],
	}
	const loaded = chainAll(model, [
		(next) => readRun(next, context, "Load"),
		(next) => readEvents(next, context, "Load"),
		(next) => readUnits(next, context, "Load"),
		(next) => readTargets(next, context),
		(next) => readFindings(next, context, "Load"),
	])
	return {
		...loaded,
		commands: [
			ReadRunClock(),
			...(isClerkAuthEnabled ? [ReadRunGrants()] : []),
			...(loaded.commands ?? []),
		],
	}
}

const dialogStep = (
	model: Model,
	field: "cancelDialog" | "reportDialog" | "findingDialog",
	step: ReturnType<typeof Dialog.update>,
): Return => ({
	model: { ...model, [field]: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		field === "cancelDialog"
			? Message.GotCancelDialogMessage({ message })
			: field === "reportDialog"
				? Message.GotReportDialogMessage({ message })
				: Message.GotFindingDialogMessage({ message }),
	),
})

/** A write changed the run: read it, its events and its ledger past any read in flight. */
const afterWrite = (model: Model, context: PageContext): Return =>
	chainAll(model, [
		(next) => readRun(next, context, "Supersede"),
		(next) => readEvents(next, context, "Supersede"),
		(next) => readUnits(next, context, "Supersede"),
	])

/** Reads the page of events before `cursor`; one older read is in flight at a time. */
const fetchOlder = (model: Model, cursor: SecurityAuditEvent): Return => ({
	model: { ...model, isLoadingOlder: true, olderCursor: cursor },
	commands: [FetchOlderEvents({ runId: model.runId, beforeAt: cursor.at, beforeId: cursor.id })],
})

/** The next gap that waited for the last older read, if any. */
const startQueuedGap = (model: Model): Return => {
	const [head, ...rest] = model.queuedGaps
	return head === undefined
		? { model }
		: fetchOlder({ ...model, queuedGaps: rest, gapUntil: head.until }, head.cursor)
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedReadGrants: ({ grants }) => ({ model: { ...model, grants } }),
		CompletedFetchRun: ({ key, result }) => {
			const wasLive = Option.match(Option.fromNullishOr(runOf(model)), {
				onNone: () => true,
				onSome: isLive,
			})
			const next: Model = { ...model, run: Keyed.accept(model.run, key, result) }
			const run = runOf(next)
			const justFinished = run !== null && wasLive && !isLive(run) && AsyncData.hasData(model.run.data)
			if (!justFinished) return { model: next }
			// A run watched to the end keeps its details open; only runs opened finished start folded.
			const settled: Model = { ...next, isDetailsOpen: next.isDetailsOpen ?? true }
			// The last poll may have missed the final phase event and ledger: read everything once more.
			return chainAll(settled, [
				(updated) =>
					readFindings(
						updated,
						context,
						AsyncData.hasData(model.findings.data) ? "Supersede" : "Load",
					),
				(updated) => readEvents(updated, context, "Supersede"),
				(updated) => readUnits(updated, context, "Supersede"),
			])
		},
		CompletedFetchEvents: ({ key, result }) => {
			const next: Model = { ...model, events: Keyed.accept(model.events, key, result) }
			if (next.events === model.events || Result.isFailure(result)) return { model: next }
			const page = result.success.events
			const newestHeld = model.eventLog[0]
			const merged: Model = { ...next, eventLog: mergeEvents(model.eventLog, page) }
			const oldest = page.at(-1)
			// A full page that never reached what we hold: more happened between polls than one page.
			const isGap =
				newestHeld !== undefined &&
				oldest !== undefined &&
				page.length >= EVENTS_PAGE &&
				!Arr.some(page, (event) => event.id === newestHeld.id) &&
				oldest.at >= newestHeld.at
			if (!isGap) return { model: merged }
			const gap = { cursor: oldest, until: newestHeld }
			// One older read at a time: a gap found meanwhile waits for it to settle.
			return model.isLoadingOlder
				? { model: { ...merged, queuedGaps: [...merged.queuedGaps, gap] } }
				: fetchOlder({ ...merged, gapUntil: gap.until }, gap.cursor)
		},
		CompletedFetchOlderEvents: ({ result }) =>
			Result.match(result, {
				onSuccess: ({ events }) => {
					const eventLog = mergeEvents(model.eventLog, events)
					const oldest = events.at(-1)
					// A page that adds nothing, or starts where it was asked to, cannot move the cursor.
					const isStuck =
						eventLog.length === model.eventLog.length || oldest?.id === model.olderCursor?.id
					const merged: Model = { ...model, eventLog, isLoadingOlder: false, olderCursor: null }
					const gap = model.gapUntil
					if (gap === null)
						return startQueuedGap({
							...merged,
							hasMoreOlder: events.length >= EVENTS_PAGE && !isStuck,
						})
					const isClosed =
						oldest === undefined ||
						isStuck ||
						events.length < EVENTS_PAGE ||
						Arr.some(events, (event) => event.id === gap.id) ||
						oldest.at < gap.at
					return isClosed
						? startQueuedGap({ ...merged, gapUntil: null })
						: fetchOlder(merged, oldest)
				},
				onFailure: (failure) => {
					const next = startQueuedGap({
						...model,
						isLoadingOlder: false,
						olderCursor: null,
						gapUntil: null,
					})
					return {
						...next,
						outMessage: toast("error", "Couldn't load older events", failure.message),
					}
				},
			}),
		CompletedFetchUnits: ({ key, result }) => ({
			model: { ...model, units: Keyed.accept(model.units, key, result) },
		}),
		CompletedFetchTargets: ({ key, result }) => ({
			model: { ...model, targets: Keyed.accept(model.targets, key, result) },
		}),
		CompletedFetchFindings: ({ key, result }) => ({
			model: { ...model, findings: Keyed.accept(model.findings, key, result) },
		}),
		TickedPoll: ({ nowMs }) =>
			chainAll({ ...model, nowMs }, [
				(next) => readRun(next, context, "Refresh"),
				(next) => readEvents(next, context, "Refresh"),
				(next) => readUnits(next, context, "Refresh"),
				// New leads land while the run hunts; a finished run's list is final.
				(next) =>
					Option.match(Option.fromNullishOr(runOf(next)), { onNone: () => false, onSome: isLive })
						? readFindings(next, context, "Refresh")
						: { model: next },
			]),
		ClickedRetry: () =>
			chainAll(model, [
				(next) => readRun(next, context, "Refresh"),
				(next) => readEvents(next, context, "Refresh"),
				(next) => readUnits(next, context, "Refresh"),
				(next) => readFindings(next, context, "Refresh"),
			]),
		ClickedLoadOlder: () => {
			const oldest = eventsOf(model).at(-1)
			if (model.isLoadingOlder || oldest === undefined) return { model }
			return fetchOlder(model, oldest)
		},
		PickedSeverity: ({ bucket }) => ({
			model: {
				...model,
				severity: bucket,
				collapsed:
					bucket === null
						? model.collapsed
						: Arr.filter(model.collapsed, (held) => held !== bucket),
			},
		}),
		ToggledSection: ({ bucket }) => ({
			model: {
				...model,
				collapsed: model.collapsed.includes(bucket)
					? Arr.filter(model.collapsed, (held) => held !== bucket)
					: [...model.collapsed, bucket],
			},
		}),
		ClickedFinding: ({ fingerprint }) => {
			// Another finding starts on its own status, never the last one's draft, even mid-save.
			const isSame = fingerprint === model.openFingerprint
			const status = Option.match(
				Arr.findFirst(resultsOf(model), (finding) => finding.fingerprint === fingerprint),
				{ onNone: () => "open" as const, onSome: (finding) => finding.status },
			)
			const next: Model = isSame
				? { ...model, openFingerprint: fingerprint }
				: {
						...model,
						openFingerprint: fingerprint,
						triage: initTriage(status),
						reason: Field.init(),
						isTriageSubmitted: false,
					}
			return dialogStep(next, "findingDialog", Dialog.open(model.findingDialog))
		},
		GotFindingDialogMessage: ({ message: inner }) =>
			dialogStep(model, "findingDialog", Dialog.update(model.findingDialog, inner)),
		GotTriageMessage: ({ message: inner }) => triageStep(model, inner),
		GotReasonMessage: ({ message: inner }) => ({
			model: { ...model, reason: Field.update(model.reason, inner).model },
		}),
		SubmittedTriage: () => {
			const finding = openFindingOf(model)
			if (finding === null || model.savingFingerprint !== null || !isTriageable(model, finding))
				return { model }
			const status = pickedTriageOf(model.triage, finding.status)
			const reason = Str.trim(model.reason.value)
			if (!isTriageChange(runTriageChoices(finding.status), status, finding.status)) return { model }
			if (reasonErrorOf(reason) !== null) return { model: { ...model, isTriageSubmitted: true } }
			return {
				model: { ...model, isTriageSubmitted: true, savingFingerprint: finding.fingerprint },
				commands: [
					UpdateRunFindingStatus({
						runId: model.runId,
						fingerprint: finding.fingerprint,
						status,
						reason,
					}),
				],
			}
		},
		CompletedTriage: ({ fingerprint, result }) => {
			if (fingerprint !== model.savingFingerprint) return { model }
			// The draft belongs to the saved finding: reset it only while that finding is the one open.
			const isStillOpen = model.openFingerprint === fingerprint
			return Result.match(result, {
				onSuccess: (triage) => {
					// The row shows the new status at once; the read that follows brings the rest.
					const findings = {
						...model.findings,
						data: AsyncData.map(model.findings.data, (data) => ({
							...data,
							findings: Arr.map(data.findings, (finding) =>
								finding.fingerprint === triage.fingerprint
									? {
											...finding,
											status: triage.status,
											statusReason: triage.statusReason,
											statusChangedAt: triage.statusChangedAt,
										}
									: finding,
							),
						})),
					}
					const settled: Model = isStillOpen
						? {
								...model,
								findings,
								savingFingerprint: null,
								isTriageSubmitted: false,
								triage: initTriage(triage.status),
								reason: Field.init(),
							}
						: { ...model, findings, savingFingerprint: null }
					const refreshed = readFindings(settled, context, "Supersede")
					return {
						...refreshed,
						outMessage: toast(
							"success",
							`Marked ${Str.toLowerCase(FINDING_STATUS_LABEL[triage.status])}`,
							"The pull request's check is reported again.",
						),
					}
				},
				onFailure: (failure) => ({
					model: { ...model, savingFingerprint: null },
					outMessage: toast("error", failure.title, failure.message),
				}),
			})
		},
		ToggledDetails: () => ({
			model: { ...model, isDetailsOpen: !(model.isDetailsOpen ?? isDetailsOpenByDefault(model)) },
		}),
		PickedUnitFilter: ({ filter }) => ({ model: { ...model, unitFilter: filter } }),
		PickedEventFilter: ({ filter }) => ({ model: { ...model, eventFilter: filter } }),
		ToggledLedger: () => ({ model: { ...model, isLedgerOpen: !model.isLedgerOpen } }),
		ClickedStartRun: () => {
			const run = runOf(model)
			if (run === null || model.busy !== null) return { model }
			return {
				model: { ...model, busy: "start" },
				commands: [StartAnotherRun({ targetId: run.targetId })],
			}
		},
		CompletedStartRun: ({ result }) =>
			Result.match(result, {
				onSuccess: (run) => ({
					model: { ...model, busy: null },
					outMessage: PageOutMessage.RequestedNavigation({
						url: hrefOf(AppRoute.SecurityRun({ runId: run.id })),
						isReplace: false,
					}),
				}),
				onFailure: (failure) => ({
					model: { ...model, busy: null },
					outMessage: toast("error", failure.title, failure.message),
				}),
			}),
		ClickedCancel: () => dialogStep(model, "cancelDialog", Dialog.open(model.cancelDialog)),
		ClickedConfirmCancel: () =>
			model.busy !== null
				? { model }
				: { model: { ...model, busy: "cancel" }, commands: [CancelRun({ runId: model.runId })] },
		CompletedCancel: ({ result }) => {
			const closed = dialogStep(
				{ ...model, busy: null },
				"cancelDialog",
				Dialog.close(model.cancelDialog),
			)
			const refreshed = afterWrite(closed.model, context)
			const commands = [...(closed.commands ?? []), ...(refreshed.commands ?? [])]
			return Result.match(result, {
				onSuccess: () => ({
					model: refreshed.model,
					commands,
					outMessage: toast("success", "Run cancelled"),
				}),
				onFailure: (failure) => ({
					model: refreshed.model,
					commands,
					outMessage: toast(
						"error",
						failure.code === "security_audit_run_not_in_progress"
							? "The run had already finished"
							: failure.title,
						failure.message,
					),
				}),
			})
		},
		GotCancelDialogMessage: ({ message: inner }) =>
			model.busy === "cancel" &&
			inner._tag !== "GotAnimationMessage" &&
			inner._tag !== "CompletedMountDialog"
				? { model }
				: dialogStep(model, "cancelDialog", Dialog.update(model.cancelDialog, inner)),
		CompletedParseReports: ({ parsed }) => ({ model: { ...model, parsedReports: parsed } }),
		ClickedReport: ({ report }) => {
			const opened = dialogStep({ ...model, report }, "reportDialog", Dialog.open(model.reportDialog))
			const reports = runOf(model)?.reports ?? null
			return reports === null || model.parsedReports.length > 0
				? opened
				: {
						...opened,
						commands: [
							...(opened.commands ?? []),
							ParseSecurityReports({
								texts: [reports.report, reports.findingsDetail, reports.needsValidation],
							}),
						],
					}
		},
		GotReportDialogMessage: ({ message: inner }) =>
			dialogStep(model, "reportDialog", Dialog.update(model.reportDialog, inner)),
	})
