import { cn } from "@maple/ui/lib/utils"
import { underlineTabClass, underlineTabStrip } from "../../kit/underline-tabs"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../route"
import { buttonVariants } from "@maple/ui/styles/ui/button"
import { icon } from "../../../ui/icon"
import { pageTitle } from "../../../ui/page-layout"
import * as Select from "../../../ui/select"
import * as SelectView from "../../../ui/select-view"
import { serviceDot } from "../../../ui/values"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { ALL_ENVIRONMENTS, DEFAULT_PRESET, environmentsOf, SERVICE_TABS, tabOf } from "./derive"
import { presetLabel } from "../../kit/time-controls"
import { Message } from "./message"
import type { Model } from "./model"
import { searchHref, tabSearch } from "./update"
import { windowSeconds, operationsBucketSeconds } from "./derive"
import * as EndpointPeekView from "./endpoint-peek/view"
import { traceSearch, peekOf } from "./update"
import { apiTab } from "./view-api-tab"
import { API_THEME_TOKENS } from "./view-api-charts"
import { dependenciesTab } from "./view-dependencies"
import { operationsTab } from "./view-operations"
import { overviewTab, THEME_TOKENS } from "./view-overview"

// TODO(unnamed-service): `UnnamedServiceHint` beside an unnamed service's title is not ported.

type H = HtmlBuilder<Message>

const toTimePicker = (message: TimeRangePicker.Message) => Message.GotTimePickerMessage({ message })
const toSelect = (message: Select.Message) => Message.GotEnvironmentSelectMessage({ message })

/** `ServiceEnvironmentSwitcher`: the overview's environments, the active one kept selectable. */
const environmentItems = (model: Model): ReadonlyArray<SelectView.SelectEntry> => {
	const loaded = AsyncData.getOrElse(
		AsyncData.map(model.overview.data, (data) => data.environments),
		() => [],
	)
	const current = environmentsOf(model.search)?.[0]
	const options = [...new Set([...loaded, ...(current === undefined ? [] : [current])])].toSorted((a, b) =>
		a.localeCompare(b),
	)
	return [
		{ _tag: "Item", item: { value: ALL_ENVIRONMENTS, label: "All environments" } },
		...options.map((env): SelectView.SelectEntry => ({ _tag: "Item", item: { value: env, label: env } })),
	]
}

const createAlert = (h: H, model: Model): Html =>
	h.a(
		[
			h.AriaLabel("Create alert"),
			h.Class(buttonVariants({ variant: "outline" })),
			h.DataAttribute("slot", "button"),
			h.Href(hrefOf(AppRoute.AlertsCreate({ search: { serviceName: model.serviceName } }))),
		],
		[icon(h, "BellIcon"), h.span([h.Class("hidden sm:inline")], ["Create alert"])],
	)

const headerActions = (h: H, model: Model): Html => {
	const controls = timeControls(h, {
		search: model.search,
		defaultPreset: DEFAULT_PRESET,
		window: model.window,
		onReset: Message.ClickedResetTimeRange(),
		onReload: Message.ClickedReload(),
		isReloading: model.isReloading,
		trigger: (label) =>
			h.submodel({
				slotId: "time-range-picker",
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
	})
	return h.submodel({
		slotId: "environment-select",
		model: { ...model.environmentSelect, value: environmentsOf(model.search)?.[0] ?? ALL_ENVIRONMENTS },
		view: SelectView.view,
		toParentMessage: toSelect,
		viewInputs: {
			entries: environmentItems(model),
			size: "sm",
			ariaLabel: "Environment",
			className: "w-full sm:w-auto",
			toView: (parts) =>
				h.div(
					[h.Class("flex flex-wrap items-center gap-2")],
					[...parts, createAlert(h, model), controls],
				),
		},
	})
}

const titleContent = (h: H, model: Model): Html =>
	pageTitle(h, { title: model.serviceName, className: "flex items-center gap-2.5" }, [
		serviceDot(h, { serviceName: model.serviceName, className: "size-3" }),
		h.span([h.Class("truncate")], [model.serviceName]),
	])

/** `UnderlineTabStrip navigation`: route links; TanStack marks a link whose search the URL contains `active`. */
const tabs = (h: H, model: Model): Html => {
	const active = tabOf(model.search)
	return underlineTabStrip(
		h,
		{ label: "Service sections", navigation: true },
		SERVICE_TABS.map((tab) => {
			const isCurrent = tab.value === active
			const isLinkActive = tab.value === "overview" || model.search.tab === tab.value
			return h.a(
				[
					h.Key(tab.value),
					...(isCurrent ? [h.AriaCurrent("page")] : []),
					h.Class(cn(underlineTabClass(isCurrent), isLinkActive && "active")),
					...(isLinkActive ? [h.DataAttribute("status", "active")] : []),
					h.Href(searchHref(model.serviceName, tabSearch(model.search, tab.value))),
					// A tab switch replaces the history entry; the href stays for new tabs.
					h.OnClick(Message.ClickedTab({ tab: tab.value }), { defaultAction: "Prevent" }),
				],
				[tab.label],
			)
		}),
	)
}

const body = (h: H, model: Model, inputs: PageViewInputs): ReadonlyArray<Html> => {
	switch (tabOf(model.search)) {
		case "overview":
			return [overviewTab(h, model, inputs.context)]
		case "operations":
			return [operationsTab(h, model, model.themeColors)]
		case "api": {
			const bucketSeconds = model.window === null ? 60 : operationsBucketSeconds(model.window)
			return [
				apiTab(h, model, { bucketSeconds, timeZone: inputs.context.timeZone }, model.themeColors),
				endpointDrawer(h, model, inputs, bucketSeconds),
			]
		}
		case "dependencies":
			return [dependenciesTab(h, model)]
	}
}

/** "ingest · production · last 12 hours": what the drawer's numbers are scoped to. */
const scopeLabel = (model: Model): string => {
	const environment = environmentsOf(model.search)?.join(", ") ?? "all environments"
	const preset = model.search.timePreset ?? (model.search.startTime === undefined ? DEFAULT_PRESET : undefined)
	const range = preset === undefined ? "custom range" : presetLabel(preset).toLowerCase()
	return [model.serviceName, environment, range].join(" · ")
}

const endpointDrawer = (h: H, model: Model, inputs: PageViewInputs, bucketSeconds: number): Html => {
	const peek = peekOf(model)
	const spanName = peek?.endpoint.spanName ?? ""
	const theme = model.themeColors
	return h.submodel({
		slotId: "endpoint-peek",
		model: model.endpointPeek,
		view: EndpointPeekView.view,
		viewInputs: {
			peek,
			buckets: AsyncData.getOrElse(model.endpointSeries.data, () => []).filter((bucket) => bucket.spanName === spanName),
			bucketSeconds,
			statusRows: AsyncData.getOrElse(model.statusBreakdown.data, () => []),
			chartContext: theme === null ? null : { theme, timeZone: inputs.context.timeZone, nowMs: model.nowMs ?? 0 },
			seconds: model.window === null ? 0 : windowSeconds(model.window),
			scopeLabel: scopeLabel(model),
			tracesHref: (filter) =>
				hrefOf(
					AppRoute.Traces({
						search: {
							...traceSearch(model, spanName),
							httpStatusCodes: filter.statusCode === undefined ? undefined : [filter.statusCode],
							sortBy: filter.slowest === true ? "durationMs" : undefined,
							sortDir: filter.slowest === true ? "desc" : undefined,
						},
					}),
				),
			alertHref: hrefOf(AppRoute.AlertsCreate({ search: { serviceName: model.serviceName } })),
			locale: "en-US",
		},
		toParentMessage: (message) => Message.GotEndpointPeekMessage({ message }),
	})
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: [...THEME_TOKENS, ...API_THEME_TOKENS] }))],
		[
			dashboardPage(
				h,
				{
					titleContent: titleContent(h, model),
					actions: headerActions(h, model),
					tabs: tabs(h, model),
				},
				body(h, model, inputs),
			),
		],
	),
)
