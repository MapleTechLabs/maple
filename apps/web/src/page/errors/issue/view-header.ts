import type { AnomalyIncidentDocument, ErrorIssueDocument, ErrorIssueId } from "@maple/domain/http"
import type { V2Investigation } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"
import { underlineTabClass, underlineTabStrip } from "../../kit/underline-tabs"
import { liveInvestigationSummary, resolveSignalState } from "../../../lib/models/error-signal"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { pageTitle } from "@maple/views/ui/page-layout"
import { timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { severityBadge } from "../kit/severity"
import { signalStateChip } from "../kit/state-chip"
import { DEFAULT_PRESET, headlineOf, type Search, type Tab } from "./derive"
import { Message } from "./message"
import { overflowEntries } from "./overflow"
import * as MenuView from "@maple/views/ui/menu-view"
import { openAnomalyBadge } from "./view-anomalies"
import type { Model } from "./model"
import { SURGE_THRESHOLD } from "./view-overview"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

// The issue header over `DetailHeader`, and the issue tabs.

type H = HtmlBuilder<Message>

/** `DetailEyebrow`: the kind segments joined by a quiet dot. */
const detailEyebrow = (h: H, segments: ReadonlyArray<string | null>): Html => {
	const shown = Arr.filter(segments, (segment): segment is string => segment !== null && segment !== "")
	return eyebrow(
		h,
		{ as: "div", className: "flex flex-wrap items-center gap-x-2 gap-y-1" },
		Arr.flatMap(shown, (segment, index) => [
			...(index > 0 ? [h.span([h.AriaHidden(true), h.Class("text-foreground-faint")], ["·"])] : []),
			h.span([h.Class("truncate")], [segment]),
		]),
	)
}

/** A fixed issue's past regressions are history, not a live signal. */
const RESOLVED_STATES = new Set(["done", "cancelled"])

/** The header's left side: eyebrow, the one `<h1>`, severity and status. */
export const headerTitle = (
	h: H,
	issue: ErrorIssueDocument,
	investigation: V2Investigation | null,
	anomalies: ReadonlyArray<AnomalyIncidentDocument> = [],
	surge: number | null = null,
): Html => {
	const headline = headlineOf(issue)
	const state = resolveSignalState(issue, liveInvestigationSummary(investigation))
	return h.div(
		[h.Class("min-w-0 space-y-2.5")],
		[
			detailEyebrow(h, [
				issue.serviceName || "Unknown service",
				issue.kind === "error" ? null : issue.kind,
			]),
			pageTitle(h, { title: headline }, [headline]),
			hstack(h, { gap: "2", wrap: true }, [
				severityBadge(h, issue.severity),
				signalStateChip(h, state, {
					onOpenInvestigation: Message.ClickedInvestigation({
						id: state.kind === "investigation" ? state.investigationId : "",
					}),
				}),
				...(surge !== null && surge >= SURGE_THRESHOLD
					? [
							badge(
								h,
								{
									variant: "outline",
									className:
										"border-severity-error-a3 bg-severity-error-a2 text-severity-error tabular-nums",
								},
								[icon(h, "ArrowTrendUpIcon", { size: 12 }), `Surging ${surge.toFixed(1)}x`],
							),
						]
					: []),
				...(issue.regressionCount > 0 && !RESOLVED_STATES.has(issue.workflowState)
					? [
							badge(
								h,
								{
									variant: "outline",
									className:
										"border-severity-warn-a3 bg-severity-warn-a2 text-severity-warn",
								},
								[
									issue.regressionCount === 1
										? "1 regression"
										: `${issue.regressionCount} regressions`,
								],
							),
						]
					: []),
				...openAnomalyBadge(h, anomalies),
			]),
		],
	)
}

/** The picker trigger and Reload (`TimeRangeHeaderControls`). */
const windowControls = (h: H, model: Model): Html =>
	timeControls(h, {
		search: model.search,
		defaultPreset: DEFAULT_PRESET,
		window: model.window,
		onReset: Message.ClickedResetTimeRange(),
		onReload: Message.ClickedReload(),
		isReloading: model.isReloading,
		trigger: (label) =>
			h.submodel({
				slotId: "issue-time-range-picker",
				model: model.timePicker,
				view: TimeRangePicker.view,
				toParentMessage: (message) => Message.GotTimePickerMessage({ message }),
				viewInputs: {
					label,
					selectedPreset:
						model.search.timePreset ??
						(model.search.startTime === undefined ? DEFAULT_PRESET : undefined),
					presets: TimeRangePicker.PRESET_VALUES,
				},
			}),
	})

/** `IssueOverflowMenu`: an outline icon trigger, the menu aligned to its end. */
const overflowMenu = (h: H, model: Model, issue: ErrorIssueDocument): Html =>
	h.submodel({
		slotId: model.overflowMenu.id,
		model: model.overflowMenu,
		view: MenuView.view,
		viewInputs: {
			entries: overflowEntries(issue),
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
								slot: "dropdown-menu-trigger",
								attributes: [h.AriaLabel("More issue actions"), ...trigger],
							},
							[icon(h, "DotsVerticalIcon")],
						),
					),
				),
		},
		toParentMessage: (message) => Message.GotOverflowMenuMessage({ message }),
	})

/** The header's actions: the window and the overflow menu. Getting it fixed lives in the body. */
export const headerActions = (h: H, model: Model, issue: ErrorIssueDocument | null): Html =>
	hstack(h, { gap: "2" }, [
		windowControls(h, model),
		...(issue === null ? [] : [overflowMenu(h, model, issue)]),
	])

const TABS: ReadonlyArray<{ readonly value: Tab; readonly label: string }> = [
	{ value: "overview", label: "Overview" },
	{ value: "occurrences", label: "Occurrences" },
	{ value: "activity", label: "Activity" },
]

/** `IssueTabs`: tab links under the header, with counts where they are known. */
export const issueTabs = (
	h: H,
	issueId: ErrorIssueId,
	search: Search,
	options: Readonly<{
		active: Tab
		showOccurrences: boolean
		occurrenceCount?: number
		activityCount?: number
	}>,
): Html =>
	underlineTabStrip(
		h,
		{ label: "Issue sections" },
		Arr.map(
			Arr.filter(TABS, (tab) => tab.value !== "occurrences" || options.showOccurrences),
			(tab) => {
				const isActive = tab.value === options.active
				const count =
					tab.value === "occurrences"
						? options.occurrenceCount
						: tab.value === "activity"
							? options.activityCount
							: undefined
				return h.a(
					[
						...(isActive ? [h.AriaCurrent("page")] : []),
						h.AriaSelected(isActive),
						h.Class(cn(underlineTabClass(isActive), isActive && "active")),
						...(isActive ? [h.DataAttribute("status", "active")] : []),
						h.Href(
							hrefOf(
								AppRoute.ErrorIssue({
									issueId,
									search: {
										...search,
										tab: tab.value === "overview" ? undefined : tab.value,
									},
								}),
							),
						),
						h.Role("tab"),
					],
					[
						tab.label,
						...(count === undefined || count === 0
							? []
							: [typography(h, { size: "xs", tone: "muted", numeric: true }, [String(count)])]),
					],
				)
			},
		),
	)
