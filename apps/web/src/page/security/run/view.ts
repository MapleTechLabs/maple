import type { SecurityAuditRunDetail } from "@maple/domain/http"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import type { BreadcrumbEntry } from "../../../shell"
import { cardButton } from "../../../ui/card-button"
import { confirmDialog } from "../../../ui/confirm-dialog"
import * as DialogView from "../../../ui/dialog-view"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { detailTitleSkeleton } from "../../kit/detail-header"
import { messageResponse } from "../../kit/message-response"
import { resourceNotFound } from "../../kit/resource-not-found"
import {
	formatElapsed,
	formatUsd,
	gateOf,
	isLive,
	REPORT_TITLE,
	type ReportDoc,
	runElapsed,
	runTotalUsd,
	shortId,
} from "../kit/format"
import { codeCrumbs, stack } from "../kit/layout"
import { gateState, placeholder } from "../kit/parts"
import {
	areasOf,
	eventsOf,
	gapCount,
	isDetailsOpen,
	phasesOf,
	resultsOf,
	runOf,
	targetOf,
	verdictsOf,
} from "./derive"
import { Message, type Model } from "./model"
import { phaseStrip, runActions, runStats, runTitle, stopBanner } from "./view-header"
import { findingSheet, findingsSection } from "./view-findings"
import { eventsPanel, gapsPanel, ledgerPanel } from "./view-panels"

// `/security/code/runs/$runId`: what the run found first, by severity; how it ran (phases, totals,
// ledger, events) below, folded once it finished.

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
		confirmLabel: "Cancel run",
		cancelLabel: "Keep running",
		isPending: model.busy === "cancel",
		onConfirm: Message.ClickedConfirmCancel(),
	})

/** How the run ran, folded under one line once it finished: phases, totals, ledger and events. */
const runDetails = (h: H, model: Model, run: SecurityAuditRunDetail, timeZone: string): Html => {
	const events = eventsOf(model)
	const isOpen = isDetailsOpen(model)
	const live = isLive(run)
	const gaps = gapCount(run)
	const summary = [
		run.unitTotal === 0 ? null : `${run.unitTotal - gaps} of ${run.unitTotal} units closed`,
		gaps === 0 || live ? null : `${gaps} ${gaps === 1 ? "gap" : "gaps"}`,
		formatUsd(runTotalUsd(run)),
		formatElapsed(runElapsed(run, model.nowMs)),
	]
		.filter((part) => part !== null)
		.join(" · ")
	return h.section(
		[h.AriaLabel("How the run ran"), h.Class("flex flex-col gap-4")],
		[
			cardButton(
				h,
				{
					onClick: Message.ToggledDetails(),
					className: "flex w-full items-center gap-2.5 p-4",
					attributes: [h.AriaExpanded(isOpen)],
				},
				[
					icon(h, isOpen ? "ChevronDownIcon" : "ChevronRightIcon", {
						size: 14,
						className: "text-muted-foreground",
					}),
					h.span([h.Class("text-sm font-medium")], ["How the run ran"]),
					h.span([h.Class("truncate text-xs text-muted-foreground")], [summary]),
					h.span(
						[h.Class("ml-auto shrink-0 text-xs text-muted-foreground")],
						[isOpen ? "Hide" : "Phases, coverage, cost and events"],
					),
				],
			),
			...(isOpen
				? [
						phaseStrip(h, phasesOf(run, events)),
						runStats(
							h,
							run,
							AsyncData.hasData(model.findings.data) ? verdictsOf(resultsOf(model)) : null,
							Option.match(AsyncData.getData(model.units.data), {
								onNone: () => null,
								onSome: (response) => areasOf(response.units),
							}),
							model.nowMs,
						),
						run.unitTotal === 0
							? eventsPanel(h, model, events, run, timeZone)
							: h.div(
									[h.Class("grid items-start gap-6 xl:grid-cols-[3fr_2fr]")],
									[
										!live && gaps > 0 && !model.isLedgerOpen
											? gapsPanel(h, model, run)
											: ledgerPanel(h, model, run),
										eventsPanel(h, model, events, run, timeZone),
									],
								),
					]
				: []),
		],
	)
}

const loaded = (h: H, model: Model, run: SecurityAuditRunDetail, timeZone: string): Html => {
	const banner = stopBanner(h, model, run)
	const body: ReadonlyArray<Html> = [
		...(banner === null ? [] : [banner]),
		...findingsSection(h, model, run),
		runDetails(h, model, run, timeZone),
	]
	return dashboardPage(
		h,
		{
			titleContent: runTitle(h, run, targetOf(model, run), model.nowMs, timeZone),
			actions: runActions(h, model, run),
			scrollClassName: "pb-8",
		},
		[stack(h, body), cancelDialog(h, model), reportSheet(h, model, run), findingSheet(h, model)],
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
									href: hrefOf(AppRoute.SecurityCodeRuns({ search: {} })),
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
		...codeCrumbs(
			run === null || target === null
				? { label: "Runs", href: hrefOf(AppRoute.SecurityCodeRuns({ search: {} })) }
				: {
						label: target.repository,
						href: hrefOf(AppRoute.SecurityCodeRuns({ search: { target: target.id } })),
					},
		),
		{ label: `Run ${shortId(model.runId)}` },
	]
}
