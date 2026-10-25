import type { SecurityAuditRunDetail } from "@maple/domain/http"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import type { BreadcrumbEntry } from "../../../shell"
import { confirmDialog } from "../../../ui/confirm-dialog"
import * as DialogView from "../../../ui/dialog-view"
import { errorState } from "../../../ui/error-state"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { detailTitleSkeleton } from "../../kit/detail-header"
import { messageResponse } from "../../kit/message-response"
import { resourceNotFound } from "../../kit/resource-not-found"
import { gateOf, isLive, REPORT_TITLE, type ReportDoc, shortId } from "../kit/format"
import { stack } from "../kit/layout"
import { gateState, placeholder } from "../kit/parts"
import { eventsOf, gapCount, phasesOf, resultsOf, runOf, targetOf, verdictsOf } from "./derive"
import { Message, type Model } from "./model"
import { phaseStrip, runActions, runStats, runTitle, stopBanner } from "./view-header"
import { eventsPanel, gapsPanel, ledgerPanel, resultsPanel } from "./view-panels"

// `/security/runs/$runId`: header, phases, totals, then the ledger and events (live) or the gaps
// and results (finished).

type H = HtmlBuilder<Message>

/** The chosen report, laid out by the chat's markdown view; text it cannot parse stays plain text. */
const REPORT_ORDER: ReadonlyArray<ReportDoc> = ["report", "findingsDetail", "needsValidation"]

/** The parse of the chosen report, once it has landed. */
const parsedReportOf = (model: Model) => model.parsedReports[REPORT_ORDER.indexOf(model.report)] ?? null

const reportSheet = (h: H, model: Model, run: SecurityAuditRunDetail): Html => {
	const text = run.reports === null ? "" : run.reports[model.report]
	const id = model.reportDialog.id
	return h.submodel({
		slotId: id,
		model: model.reportDialog,
		view: DialogView.view,
		viewInputs: {
			hasTrigger: false,
			side: "right",
			className: "sm:max-w-3xl",
			toView: ({ portal }) => portal ?? h.empty,
			toContent: () => [
				DialogView.dialogHeader(h, "sheet", [
					DialogView.dialogTitle(h, "sheet", id, REPORT_TITLE[model.report]),
				]),
				DialogView.dialogPanel(h, "sheet", id, [
					messageResponse(h, parsedReportOf(model)?.document ?? null, text, "text-sm"),
				]),
			],
		},
		toParentMessage: (message) => Message.GotReportDialogMessage({ message }),
	})
}

const cancelDialog = (h: H, model: Model): Html =>
	confirmDialog(h, {
		slotId: "security-cancel-run-dialog",
		model: model.cancelDialog,
		toParentMessage: (message) => Message.GotCancelDialogMessage({ message }),
		title: "Cancel this run?",
		description:
			"The agents stop after the ones in flight. Units it closed stay closed; the rest are left as gaps the next run starts with. Spend so far is kept.",
		confirmLabel: model.busy === "cancel" ? "Cancelling..." : "Cancel run",
		cancelLabel: "Keep running",
		isConfirmDisabled: model.busy === "cancel",
		onConfirm: Message.ClickedConfirmCancel(),
	})

const loaded = (h: H, model: Model, run: SecurityAuditRunDetail, timeZone: string): Html => {
	const events = eventsOf(model)
	const results = resultsOf(model)
	const live = isLive(run)
	const banner = stopBanner(h, model, run)
	const body: ReadonlyArray<Html> = [
		...(banner === null ? [] : [banner]),
		phaseStrip(h, phasesOf(run, events)),
		runStats(h, run, AsyncData.hasData(model.findings.data) ? verdictsOf(results) : null),
		live
			? h.div(
					[h.Class("grid items-start gap-6 xl:grid-cols-[3fr_2fr]")],
					[ledgerPanel(h, model, run), eventsPanel(h, model, events, run, timeZone)],
				)
			: run.unitTotal === 0
				? resultsPanel(h, model, results, run)
				: h.div(
						[h.Class("grid items-start gap-6 xl:grid-cols-[3fr_2fr]")],
						[
							gapCount(run) > 0 && !model.isLedgerOpen
								? gapsPanel(h, model, run)
								: ledgerPanel(h, model, run),
							resultsPanel(h, model, results, run),
						],
					),
		...(live ? [] : [eventsPanel(h, model, events, run, timeZone)]),
	]
	return dashboardPage(
		h,
		{
			titleContent: runTitle(h, run, targetOf(model, run), model.nowMs, timeZone),
			actions: runActions(h, model, run),
			scrollClassName: "pb-8",
		},
		[stack(h, body), cancelDialog(h, model), reportSheet(h, model, run)],
	)
}

const isNotFound = (failure: { readonly code: string }) => failure.code === "security_audit_run_not_found"

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	AsyncData.matchData(model.run.data, {
		onEmpty: () =>
			dashboardPage(h, { titleContent: detailTitleSkeleton(h) }, [
				placeholder(h, "h-24 w-full"),
				placeholder(h, "h-24 w-full"),
				placeholder(h, "h-80 w-full"),
			]),
		onFailure: (failure) => {
			const gate = gateOf(failure)
			return dashboardPage(h, {}, [
				gate !== null
					? gateState(h, gate)
					: isNotFound(failure)
						? resourceNotFound(h, {
								title: "Run not found",
								description: "It may belong to another organization, or the link is stale.",
								back: {
									href: hrefOf(AppRoute.SecurityRuns({ search: {} })),
									label: "Back to runs",
								},
							})
						: errorState(h, {
								failure,
								title: "Couldn't load the run",
								onRetry: Message.ClickedRetry(),
							}),
			])
		},
		onData: (run) => loaded(h, model, run, inputs.context.timeZone),
	}),
)

export const breadcrumbsOf = (model: Model): ReadonlyArray<BreadcrumbEntry> => {
	const run = runOf(model)
	const target = run === null ? null : targetOf(model, run)
	return [
		{ label: "Security", href: hrefOf(AppRoute.Security()) },
		...(run === null || target === null
			? [{ label: "Runs", href: hrefOf(AppRoute.SecurityRuns({ search: {} })) }]
			: [
					{
						label: target.repository,
						href: hrefOf(AppRoute.SecurityRuns({ search: { target: target.id } })),
					},
				]),
		{ label: `Run ${shortId(model.runId)}` },
	]
}
