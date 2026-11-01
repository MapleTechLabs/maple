import type { AnomalyIncidentDocument, ErrorIssueDocument, ErrorIssueId } from "@maple/domain/http"
import type { V2Investigation } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"
import { underlineTabClass, underlineTabStrip } from "../../kit/underline-tabs"
import { liveInvestigationSummary, resolveSignalState } from "../../../lib/models/error-signal"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "../../../ui/button"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { pageTitle } from "../../../ui/page-layout"
import { timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { severityBadge } from "../kit/severity"
import { signalStateChip } from "../kit/state-chip"
import { DEFAULT_PRESET, headlineOf, type Search, type Tab } from "./derive"
import { Message } from "./message"
import { overflowEntries } from "./overflow"
import * as MenuView from "../../../ui/menu-view"
import { openAnomalyBadge } from "./view-anomalies"
import type { Model } from "./model"

// The issue header over `DetailHeader`, and the issue tabs.

type H = HtmlBuilder<Message>

/** `DetailEyebrow`: the kind segments joined by a quiet dot. */
const detailEyebrow = (h: H, segments: ReadonlyArray<string | null>): Html => {
	const shown = segments.filter((segment): segment is string => segment !== null && segment !== "")
	return eyebrow(
		h,
		{ as: "div", className: "flex flex-wrap items-center gap-x-2 gap-y-1" },
		shown.flatMap((segment, index) => [
			...(index > 0 ? [h.span([h.AriaHidden(true), h.Class("text-foreground-faint")], ["·"])] : []),
			h.span([h.Class("truncate")], [segment]),
		]),
	)
}

/** The header's left side: eyebrow, the one `<h1>`, severity and status. */
export const headerTitle = (
	h: H,
	issue: ErrorIssueDocument,
	investigation: V2Investigation | null,
	anomalies: ReadonlyArray<AnomalyIncidentDocument> = [],
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
			h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					severityBadge(h, issue.severity),
					signalStateChip(h, state, {
						onOpenInvestigation: Message.ClickedInvestigation({
							id: state.kind === "investigation" ? state.investigationId : "",
						}),
					}),
					...openAnomalyBadge(h, anomalies),
				],
			),
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

/** The header's actions: the window, Investigate (or the linked one) and the overflow menu. */
export const headerActions = (
	h: H,
	model: Model,
	investigation: V2Investigation | null,
	issue: ErrorIssueDocument | null,
): Html =>
	h.div(
		[h.Class("flex items-center gap-2")],
		[
			windowControls(h, model),
			investigation !== null
				? linkButton(
						h,
						{
							size: "sm",
							href: hrefOf(AppRoute.Investigation({ id: investigation.id, search: {} })),
						},
						[icon(h, "PulseIcon"), "Open investigation"],
					)
				: button(
						h,
						{
							size: "sm",
							isDisabled: issue === null || model.isStartingInvestigation,
							attributes: [h.OnClick(Message.ClickedInvestigate())],
						},
						[icon(h, "PulseIcon"), "Investigate"],
					),
			...(issue === null ? [] : [overflowMenu(h, model, issue)]),
		],
	)

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
		TABS.filter((tab) => tab.value !== "occurrences" || options.showOccurrences).map((tab) => {
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
								search: { ...search, tab: tab.value === "overview" ? undefined : tab.value },
							}),
						),
					),
					h.Role("tab"),
				],
				[
					tab.label,
					...(count === undefined
						? []
						: [h.span([h.Class("text-xs text-muted-foreground tabular-nums")], [String(count)])]),
				],
			)
		}),
	)
