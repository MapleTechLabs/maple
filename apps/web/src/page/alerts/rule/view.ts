import type { AlertRuleDocument } from "@maple/domain/http"
import { comparatorLabels, formatSignalValue, signalLabels } from "@maple/web-data/alerts/form-utils"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import { linkButton } from "../../../ui/button"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { pageTitle } from "../../../ui/page-layout"
import { skeleton } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { resourceNotFound } from "../../kit/resource-not-found"
import { timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { linkTabStrip } from "../../kit/underline-tabs"
import { alertStatusBadge, severityBadge } from "../shared/badges"
import { alertsHref, createHref, ruleHref } from "../shared/links"
import { RULE_CHART_TOKENS } from "../shared/rule-chart"
import { DEFAULT_PRESET, ruleIncidentsOf, ruleOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { historyTab } from "./view-history"
import { overviewTab } from "./view-overview"

// The rule detail page through `ResultPage` and `DetailHeader`.

type H = HtmlBuilder<Message>

const TABS = ["overview", "history"] as const
type Tab = (typeof TABS)[number]
const activeTabOf = (model: Model): Tab => (model.search.tab === "history" ? "history" : "overview")

export const ruleSubtitle = (rule: AlertRuleDocument): string => {
	const tiers = rule.thresholds
		.map((tier) =>
			rule.thresholds.length > 1
				? `${tier.severity} ${formatSignalValue(rule.signalType, tier.value)}`
				: formatSignalValue(rule.signalType, tier.value),
		)
		.join(", ")
	return `${signalLabels[rule.signalType]} ${comparatorLabels[rule.comparator]} ${tiers} over ${rule.windowMinutes}min${rule.serviceNames?.length > 0 ? ` on ${rule.serviceNames.join(", ")}` : ""}${rule.environments?.length > 0 ? ` in ${rule.environments.join(", ")}` : ""}${rule.excludeServiceNames?.length > 0 ? ` (excl. ${rule.excludeServiceNames.join(", ")})` : ""}`
}

const toTimePicker = (message: TimeRangePicker.Message) => Message.GotTimePickerMessage({ message })

/** `DetailHeader` (kind eyebrow, title, meta row) with the time controls and Edit rule. */
const header = (h: H, model: Model, rule: AlertRuleDocument) => {
	const openIncidents = ruleIncidentsOf(model).filter((i) => i.status === "open")
	const isFiring = openIncidents.length > 0
	return {
		titleContent: h.div(
			[h.Class("min-w-0 space-y-2.5")],
			[
				eyebrow(h, { as: "div", className: "flex flex-wrap items-center gap-x-2 gap-y-1" }, [
					h.span([h.Class("truncate")], ["Alert rule"]),
				]),
				pageTitle(h, { title: rule.name }, [rule.name]),
				h.div(
					[h.Class("flex flex-wrap items-center gap-2")],
					[
						...rule.thresholds.map((tier) => severityBadge(h, tier.severity)),
						isFiring
							? alertStatusBadge(
									h,
									openIncidents.every((i) => i.holdReason != null) ? "held" : "firing",
								)
							: alertStatusBadge(h, rule.enabled ? "ok" : "disabled"),
						h.span([h.Class("text-muted-foreground text-sm")], [ruleSubtitle(rule)]),
					],
				),
			],
		),
		actions: h.div(
			[h.Class("flex items-center gap-2")],
			[
				timeControls(h, {
					search: model.search,
					defaultPreset: DEFAULT_PRESET,
					window: model.window,
					onReset: Message.ClickedResetTimeRange(),
					onReload: Message.ClickedReload(),
					isReloading: model.isReloading,
					trigger: (label) =>
						h.submodel({
							slotId: "alert-rule-time-picker",
							model: model.timePicker,
							view: TimeRangePicker.view,
							toParentMessage: toTimePicker,
							viewInputs: {
								label,
								selectedPreset:
									model.search.timePreset ??
									(model.search.startTime === undefined ? DEFAULT_PRESET : undefined),
								presets: TimeRangePicker.LONG_RANGE_PRESET_VALUES,
							},
						}),
				}),
				linkButton(h, { variant: "outline", size: "sm", href: createHref({ ruleId: rule.id }) }, [
					icon(h, "PencilIcon"),
					"Edit rule",
				]),
			],
		),
	}
}

const tabStrip = (h: H, model: Model): Html => {
	const active = activeTabOf(model)
	return linkTabStrip(
		h,
		"Rule sections",
		TABS.map((tab) => ({
			key: tab,
			// `search={(prev) => ({ ...prev, tab })}`: the time range rides along.
			href: ruleHref(model.ruleId, { ...model.search, tab }),
			label: tab === "overview" ? "Overview" : "History",
			isCurrent: tab === active,
			isRouteActive: tab === active,
		})),
	)
}

const loadingBody = (h: H): Html =>
	h.div(
		[h.Class("space-y-6")],
		[
			skeleton(h, "h-14 w-full"),
			h.div([h.Class("space-y-2")], [skeleton(h, "h-3.5 w-40"), skeleton(h, "h-[300px] w-full")]),
			skeleton(h, "h-52 w-full"),
			skeleton(h, "h-64 w-full"),
		],
	)

const historyLoading = (h: H): Html =>
	h.div([h.Class("space-y-4")], [skeleton(h, "h-24 w-full"), skeleton(h, "h-64 w-full")])

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const timeZone = inputs.context.timeZone
	const rule = model.rules === null ? null : ruleOf(model)
	const page =
		model.rules === null
			? dashboardPage(h, {}, [loadingBody(h)])
			: rule === null
				? dashboardPage(h, {}, [
						resourceNotFound(h, {
							title: "Rule not found",
							description: "This alert rule could not be found. It may have been deleted.",
							back: { href: alertsHref({}), label: "Back to rules" },
						}),
					])
				: dashboardPage(h, { ...header(h, model, rule), tabs: tabStrip(h, model) }, [
						activeTabOf(model) === "overview"
							? overviewTab(h, model, rule, timeZone)
							: model.incidents === null
								? historyLoading(h)
								: historyTab(h, model, rule, ruleIncidentsOf(model), timeZone, model.nowMs),
					])
	return h.div([h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: RULE_CHART_TOKENS }))], [page])
})

export const breadcrumbsOf = (model: Model) => {
	const rule = model.rules === null ? null : ruleOf(model)
	return [
		{ label: "Alerts", href: "/alerts" },
		{ label: model.rules === null ? "Loading…" : rule === null ? "Not found" : rule.name },
	]
}
