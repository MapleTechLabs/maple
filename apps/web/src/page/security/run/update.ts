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
	StartAnotherRun,
} from "./command"
import { eventsOf, runOf } from "./derive"
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
		olderEvents: [],
		isLoadingOlder: false,
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
			// The run just finished: its findings changed, so read them past the cached answer.
			const mode: Keyed.ReadMode =
				run !== null && wasLive && !isLive(run) && AsyncData.hasData(model.findings.data)
					? "Refresh"
					: "Load"
			return readFindings(next, context, mode)
		},
		CompletedFetchEvents: ({ key, result }) => ({
			model: { ...model, events: Keyed.accept(model.events, key, result) },
		}),
		CompletedFetchOlderEvents: ({ result }) =>
			Result.match(result, {
				onSuccess: ({ events }) => ({
					model: {
						...model,
						olderEvents: [...model.olderEvents, ...events],
						isLoadingOlder: false,
						hasMoreOlder: events.length >= EVENTS_PAGE,
					},
				}),
				onFailure: (failure) => ({
					model: { ...model, isLoadingOlder: false },
					outMessage: toast("error", "Failed to load older events", failure.message),
				}),
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
			]),
		ClickedLoadOlder: () => {
			const oldest = eventsOf(model).at(-1)
			if (model.isLoadingOlder || oldest === undefined) return { model }
			return {
				model: { ...model, isLoadingOlder: true },
				commands: [
					FetchOlderEvents({ runId: model.runId, beforeAt: oldest.at, beforeId: oldest.id }),
				],
			}
		},
		PickedUnitFilter: ({ filter }) => ({ model: { ...model, unitFilter: filter } }),
		ToggledLedger: () => ({ model: { ...model, isLedgerOpen: !model.isLedgerOpen } }),
		ClickedStartRun: ({ budget }) => {
			const run = runOf(model)
			if (run === null || model.busy !== null) return { model }
			return {
				model: { ...model, busy: "start" },
				commands: [StartAnotherRun({ targetId: run.targetId, budget })],
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
		ClickedReport: ({ report }) =>
			dialogStep({ ...model, report }, "reportDialog", Dialog.open(model.reportDialog)),
		GotReportDialogMessage: ({ message: inner }) =>
			dialogStep(model, "reportDialog", Dialog.update(model.reportDialog, inner)),
	})
