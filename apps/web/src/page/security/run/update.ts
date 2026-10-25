import type { SecurityAuditEvent } from "@maple/domain/http"
import { Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import { isClerkAuthEnabled } from "../../../lib/services/common/auth-mode"
import { AppRoute, hrefOf } from "../../../route"
import * as Dialog from "../../../ui/dialog"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { chainAll, slotStep } from "../../kit/keyed-step"
import { isLive } from "../kit/format"
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
	ReadRunIsAdmin,
	ParseSecurityReports,
	StartAnotherRun,
} from "./command"
import { eventsOf, mergeEvents, runOf } from "./derive"
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

/** The target's findings, once the run says which target; this run's results are among them. */
const readFindings = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	const run = runOf(model)
	if (run === null) return { model }
	const targetId = run.targetId
	return slotStep(
		model,
		model.findings,
		(findings) => ({ findings }),
		keyOf(context, "listFindings", { targetId }),
		mode,
		(key) => FetchRunFindings({ key, targetId }),
	)
}

export const init = (route: SecurityRunRoute, context: PageContext): Return => {
	const model: Model = {
		runId: route.runId,
		nowMs: 0,
		isAdmin: !isClerkAuthEnabled,
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
		unitFilter: "all",
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
	])
	return {
		...loaded,
		commands: [
			ReadRunClock(),
			...(isClerkAuthEnabled ? [ReadRunIsAdmin()] : []),
			...(loaded.commands ?? []),
		],
	}
}

const dialogStep = (
	model: Model,
	field: "cancelDialog" | "reportDialog",
	step: ReturnType<typeof Dialog.update>,
): Return => ({
	model: { ...model, [field]: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		field === "cancelDialog"
			? Message.GotCancelDialogMessage({ message })
			: Message.GotReportDialogMessage({ message }),
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
		CompletedReadIsAdmin: ({ isAdmin }) => ({ model: { ...model, isAdmin } }),
		CompletedFetchRun: ({ key, result }) => {
			const wasLive = Option.match(Option.fromNullishOr(runOf(model)), {
				onNone: () => true,
				onSome: isLive,
			})
			const next: Model = { ...model, run: Keyed.accept(model.run, key, result) }
			const run = runOf(next)
			const justFinished = run !== null && wasLive && !isLive(run) && AsyncData.hasData(model.run.data)
			if (!justFinished) return readFindings(next, context, "Load")
			// The last poll may have missed the final phase event and ledger: read everything once more.
			return chainAll(next, [
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
				!page.some((event) => event.id === newestHeld.id) &&
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
						events.some((event) => event.id === gap.id) ||
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
		PickedUnitFilter: ({ filter }) => ({ model: { ...model, unitFilter: filter } }),
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
