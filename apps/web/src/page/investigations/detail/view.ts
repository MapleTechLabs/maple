import type { IssueSeverity } from "@maple/domain/http"
import type { V2Investigation } from "@maple/domain/http/v2"
import { pageScrollAreaStyles } from "@maple/ui/styles/ui/page-layout"
import { investigationHeadline, investigationScope } from "@maple/web-data/investigations/display"
import { Mount, Submodel } from "foldkit"
import { Message as ConversationMessageUnion, type Message as ConversationMessage } from "../../chat/conversation/message"
import { conversationView, emptyNotice } from "../../chat/conversation/view"
import { MountMessageScroller } from "../../chat/kit/scroller"
import { findDiagnosisMessageId } from "../../chat/kit/transcript-rows"
import { contextOf, placeholderOf, suggestionsOf } from "./conversation"
import { investigationNoun } from "./investigation-context"
import { diagnosisReportCard, reportOfDiagnosis } from "./view-diagnosis-card"
import type { Html, HtmlBuilder } from "foldkit/html"
import { toLoadFailure } from "../../../data/load-failure"
import { AppRoute, hrefOf } from "../../../route"
import type { BreadcrumbEntry } from "../../../shell"
import { button } from "../../../ui/button"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import * as MenuView from "../../../ui/menu-view"
import * as Tooltip from "../../../ui/tooltip"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { detailActions, detailTitle, detailTitleSkeleton } from "../../kit/detail-header"
import { resourceNotFound } from "../../kit/resource-not-found"
import { underlineTabClass, underlineTabStrip } from "../../kit/underline-tabs"
import { severityBadge } from "../../errors/kit/severity"
import { investigationKindLabel, statusBadge } from "../kit"
import { breadcrumbLabel, type Tab, tabOf, traceTips } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { actionSheet } from "./view-action-sheet"
import { provenanceCanvas, provenanceLoading } from "./view-canvas"
import { evidenceTab, followUpComposer, impactStrip, investigationMeta, signalsCard, type TipTrigger } from "./view-sections"
import { verdictCard } from "./view-verdict"

// The investigation page: `InvestigationView`, `InvestigationHeader`, `InvestigationTabs`.

type H = HtmlBuilder<Message>

/** Only the four canonical severities render as a badge. */
const asIssueSeverity = (value: string | null | undefined): IssueSeverity | null =>
	value === "critical" || value === "high" || value === "medium" || value === "low" ? value : null

const titleContent = (h: H, investigation: V2Investigation): Html => {
	const scope = investigationScope(investigation)
	const severity = asIssueSeverity(investigation.severity ?? investigation.snapshot.severity)
	return detailTitle(h, {
		kind: ["Investigation", investigationKindLabel(investigation.subject)],
		title: [investigationHeadline(investigation)],
		meta: [
			statusBadge(h, investigation.status),
			...(severity === null ? [] : [severityBadge(h, severity)]),
			...(scope ? [h.span([h.Title(scope), h.Class("min-w-0 max-w-[28rem] truncate text-sm text-muted-foreground")], [scope])] : []),
		],
	})
}

/** `InvestigationActions`: the status's primary verb, and the overflow menu. */
const headerActions = (h: H, model: Model, investigation: V2Investigation): Html => {
	const status = investigation.status
	const isBusy = model.busy !== null
	const primary =
		status === "failed"
			? { label: "Retry", variant: "default" as const }
			: status === "inconclusive"
				? { label: "Run again", variant: "default" as const }
				: status === "resolved"
					? { label: "Reopen", variant: "outline" as const }
					: { label: "Resolve", variant: "default" as const }
	const entries: ReadonlyArray<MenuView.MenuEntry> = [
		{ _tag: "Item", value: "restart", label: "Run again", icon: "ArrowPathIcon", isDisabled: isBusy },
		...(status === "resolved" ? [] : [{ _tag: "Item" as const, value: "resolve", label: "Mark resolved", isDisabled: isBusy }]),
	]
	return detailActions(h, [
		h.div(
			[h.Class("flex items-center gap-2")],
			[
				button(
					h,
					{ size: "sm", variant: primary.variant, isDisabled: isBusy, attributes: [h.OnClick(Message.ClickedPrimary())] },
					[primary.label],
				),
				h.submodel({
					slotId: "investigation-actions",
					model: model.actionsMenu,
					view: MenuView.view,
					viewInputs: {
						entries,
						align: "end",
						toView: ({ trigger, withTrigger }) =>
							h.span(
								[h.Class("contents")],
								withTrigger(
									button(
										h,
										{
											variant: "outline",
											size: "icon-sm",
											attributes: [h.AriaLabel("More investigation actions"), ...trigger],
										},
										[icon(h, "DotsVerticalIcon")],
									),
								),
							),
					},
					toParentMessage: (message) => Message.GotActionsMenuMessage({ message }),
				}),
			],
		),
	])
}

const TABS: ReadonlyArray<{ value: Tab; label: string }> = [
	{ value: "overview", label: "Overview" },
	{ value: "evidence", label: "Evidence" },
	{ value: "chat", label: "Chat" },
	{ value: "transcript", label: "Transcript" },
]

/** `InvestigationTabs`: links, so the open tab is in the URL; Evidence only when there is some. */
const tabs = (h: H, investigation: V2Investigation, active: Tab): Html => {
	const evidenceCount = investigation.report?.evidence.length ?? 0
	return underlineTabStrip(
		h,
		{ label: "Investigation sections" },
		TABS.filter((tab) => tab.value !== "evidence" || evidenceCount > 0).map((tab) => {
			const isActive = tab.value === active
			const href = hrefOf(AppRoute.Investigation({ id: investigation.id, search: tab.value === "overview" ? {} : { tab: tab.value } }))
			return h.keyed("a")(
				tab.value,
				[
					h.Href(href),
					h.Role("tab"),
					h.AriaSelected(isActive),
					...(isActive ? [h.AriaCurrent("page"), h.DataAttribute("status", "active")] : []),
					h.Class(`${underlineTabClass(isActive)}${isActive ? " active" : ""}`),
				],
				[
					tab.label,
					...(tab.value === "evidence" ? [h.span([h.Class("text-xs text-muted-foreground tabular-nums")], [String(evidenceCount)])] : []),
				],
			)
		}),
	)
}

const documentTab = (
	h: H,
	model: Model,
	investigation: V2Investigation,
	tab: Tab,
	timeZone: string,
	trigger: TipTrigger,
): ReadonlyArray<Html> => {
	const isResolved = investigation.status === "resolved"
	const canvas = provenanceCanvas(h, model, investigation, timeZone)
	const signals = signalsCard(h, model, investigation)
	const sections =
		tab === "evidence"
			? [evidenceTab(h, investigation, trigger)]
			: [
					verdictCard(h, investigation, model.nowMs),
					...(canvas === null ? [] : [canvas]),
					impactStrip(h, investigation, timeZone),
					...(signals === null ? [] : [signals]),
				]
	return [
		h.div(
			[h.DataAttribute("slot", "page-scroll-area"), h.Class(pageScrollAreaStyles)],
			[h.div([h.Class("flex flex-col gap-7")], [...sections, investigationMeta(h, model, investigation)])],
		),
		...(isResolved ? [] : [h.div([h.Class("shrink-0 px-4 pb-4")], [followUpComposer(h)])]),
	]
}

/** `InvestigationLead`: what a thread with no turns says, read off the subject's own status. */
const investigationLead = (h: H, investigation: V2Investigation): Html =>
	investigation.status === "investigating"
		? emptyNotice(
				h,
				"Investigating",
				"Maple is gathering evidence — the Transcript tab shows what it is doing as it goes. You can ask a question here without waiting for it to finish.",
			)
		: investigation.status === "failed"
			? emptyNotice(
					h,
					"Autonomous pass failed",
					"Maple couldn't complete the investigation. Retry it from the header, or ask a question to continue by hand.",
				)
			: emptyNotice(
					h,
					"Ready to investigate",
					`This ${investigationNoun(contextOf(investigation).kind)} is attached to every message in the thread. Start with a suggestion or ask your own question.`,
				)

/** `ChatConversation mode="investigation"`: the thread, led by the report until its own turn lands. */
const conversationTab = (
	h: H,
	model: Model,
	investigation: V2Investigation,
	timeZone: string,
	trigger: TipTrigger,
): ReadonlyArray<Html> => {
	const { conversation } = model
	if (conversation === null) return []
	const toMessage = (message: ConversationMessage) => Message.GotConversationMessage({ message })
	const hasDiagnosisTurn = findDiagnosisMessageId(conversation.messages) !== undefined
	const report = investigation.report
	return [
		conversationView(h, conversation, {
			toMessage,
			timeZone,
			textareaId: `investigation-chat-${model.id}`,
			placeholder: placeholderOf(investigation),
			emptyState: () => investigationLead(h, investigation),
			chips: [],
			scrollerMount: Mount.mapMessage(MountMessageScroller({ focusMessageId: null }), () => Message.CompletedMountScroller()),
			knownServices: new Set(model.knownServices ?? []),
			nowMs: model.nowMs,
			fallback: report === null || hasDiagnosisTurn ? undefined : diagnosisReportCard(h, model, report, trigger),
			diagnosisCard: (diagnosis) => diagnosisReportCard(h, model, reportOfDiagnosis(diagnosis), trigger),
			suggestions: {
				items: suggestionsOf(investigation),
				onSelect: (text) => toMessage(ConversationMessageUnion.ClickedSuggestion({ text })),
			},
		}),
	]
}

const readyPage = (h: H, model: Model, investigation: V2Investigation, timeZone: string): Html => {
	const tab = tabOf(model)
	const isConversation = tab === "chat" || tab === "transcript"
	const tips = traceTips(investigation)
	return h.submodel({
		slotId: "investigation-trace-tooltip",
		model: model.traceTooltip,
		view: Tooltip.view,
		toParentMessage: (message: Tooltip.Message) => Message.GotTraceTooltipMessage({ message }),
		viewInputs: {
			triggerIds: [...tips.keys()],
			toContent: (id) => [tips.get(id) ?? ""],
			className: "font-mono",
			toView: ({ trigger, portal }) =>
				dashboardPage(
					h,
					{
						titleContent: titleContent(h, investigation),
						actions: headerActions(h, model, investigation),
						sticky: tabs(h, investigation, tab),
						fill: true,
					},
					[
						...(isConversation
							? conversationTab(h, model, investigation, timeZone, trigger)
							: documentTab(h, model, investigation, tab, timeZone, trigger)),
						actionSheet(h, model, investigation, timeZone, trigger),
						...(portal === null ? [] : [portal]),
					],
				),
		},
	})
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const timeZone = inputs.context.timeZone
	switch (model.sync._tag) {
		case "Ready":
			return readyPage(h, model, model.sync.investigation, timeZone)
		case "Missing":
			return dashboardPage(h, {}, [
				resourceNotFound(h, {
					title: "This investigation is unavailable",
					description: "It may have been removed, or it belongs to a different organization.",
					back: { href: "/investigations", label: "View investigations" },
				}),
			])
		case "Failed":
			return dashboardPage(h, {}, [
				errorState(h, {
					failure: toLoadFailure({ message: "The live connection to this investigation was lost" }),
					title: "This investigation could not be loaded",
					onRetry: Message.ClickedRetrySync(),
				}),
			])
		case "Loading":
			return dashboardPage(h, { titleContent: detailTitleSkeleton(h) }, [provenanceLoading(h)])
	}
})

export const breadcrumbsOf = (model: Model): ReadonlyArray<BreadcrumbEntry> => [
	{ label: "Investigations", href: "/investigations" },
	{
		label:
			model.sync._tag === "Ready"
				? breadcrumbLabel(investigationHeadline(model.sync.investigation))
				: model.sync._tag === "Missing"
					? "Not found"
					: model.sync._tag === "Failed"
						? "Error"
						: "Loading…",
	},
]
