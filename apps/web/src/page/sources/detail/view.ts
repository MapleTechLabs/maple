import type { V2Source } from "@maple/domain/http/v2"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { BAR_CHART_TOKENS } from "../../../charts/bar-chart"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../route"
import type { SourceTab } from "../../../route/search"
import type { BreadcrumbEntry } from "../../../shell"
import { alert, alertTitle } from "../../../ui/alert"
import { copyableField } from "../../../ui/copyable-field"
import { errorState } from "../../../ui/error-state"
import { panel } from "../../../ui/panel"
import { skeleton } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { detailActions, detailTitle } from "../../kit/detail-header"
import { resourceNotFound } from "../../kit/resource-not-found"
import { underlineTabClass, underlineTabStrip } from "../../kit/underline-tabs"
import { platformMeta, platformTile } from "../kit/platforms"
import { effectiveTab, hasToken, integrationPlatformOf, focusIdOf, sourceHref, tabsOf } from "../kit/shared"
import { actionsEmbed, cardEmbed } from "../../integrations/embed"
import { sourceStatusBadge } from "../kit/status"
import { Message } from "./message"
import type { Model } from "./model"
import { sourceOf } from "./update"
import { pauseControl, sourceActions } from "./view-actions"
import { overviewTab } from "./view-overview"
import { settingsTab, setupTab } from "./view-tabs"

type H = HtmlBuilder<Message>

const SOURCES_HREF = hrefOf(AppRoute.Sources())
const TAB_LABELS = {
	overview: "Overview",
	setup: "Setup",
	connection: "Connection",
	settings: "Settings",
} as const satisfies Record<SourceTab, string>

const notFound = (h: H): Html =>
	resourceNotFound(h, {
		title: "Source not found",
		description: "It may have been deleted, or the link is wrong.",
		back: { href: SOURCES_HREF, label: "Back to sources" },
	})

const loading = (h: H): Html =>
	h.div([h.Class("flex flex-col gap-3")], [skeleton(h, "h-10 w-72"), skeleton(h, "h-40 w-full")])

/** `SourceTabs`: links, so the open tab is in the URL; the overview drops `tab`. */
const tabs = (h: H, source: V2Source, active: SourceTab): Html =>
	underlineTabStrip(
		h,
		{ label: "Source sections" },
		tabsOf(source).map((tab) => {
			const isActive = tab === active
			return h.keyed("a")(
				tab,
				[
					h.Href(sourceHref(source, tab)),
					h.Role("tab"),
					h.AriaSelected(isActive),
					...(isActive ? [h.AriaCurrent("page"), h.DataAttribute("status", "active")] : []),
					h.Class(`${underlineTabClass(isActive)}${isActive ? " active" : ""}`),
				],
				[TAB_LABELS[tab]],
			)
		}),
	)

/** `RolledTokenBanner`: the one-time token after a roll, above whichever tab is open. */
const rolledBanner = (h: H, model: Model, secret: string): Html =>
	panel(h, { padded: true, className: "gap-3" }, [
		alert(h, { variant: "ok" }, [
			alertTitle(h, [
				"Token rolled. Copy it now, it won't be shown again. The old one stops working within a minute.",
			]),
		]),
		copyableField(h, {
			id: "source-rolled-token",
			value: secret,
			copyLabel: "Source token",
			copy: model.tokenCopy,
			toCopyMessage: (message) => Message.GotTokenCopyMessage({ message }),
		}),
	])

/** An integration source's integration, rendered through its own module (`slot` keeps the two apart). */
const connectionPart = (
	h: H,
	model: Model,
	source: V2Source,
	timeZone: string,
	part: "card" | "actions",
): Html | null => {
	const platform = integrationPlatformOf(source)
	if (platform === null || model.connection === null) return null
	return h.submodel({
		slotId: `source-connection-${part}`,
		model: model.connection,
		view: part === "card" ? cardEmbed : actionsEmbed,
		viewInputs: { integration: platform, timeZone, focusId: focusIdOf(source) },
		toParentMessage: (message) => Message.GotConnectionMessage({ message }),
	})
}

/** Token sources take their own actions; an integration source pauses beside its integration's. */
const headerActions = (h: H, model: Model, source: V2Source, timeZone: string): Html | undefined => {
	if (hasToken(source)) return detailActions(h, sourceActions(h, model, source))
	const connection = connectionPart(h, model, source, timeZone, "actions")
	const pausable = !source.is_default
	const children = [
		...(pausable ? [pauseControl(h, model, source)] : []),
		...(connection === null ? [] : [connection]),
	]
	return children.length === 0 ? undefined : detailActions(h, children)
}

const found = (h: H, model: Model, source: V2Source, inputs: PageViewInputs, nowMs: number): Html => {
	const shown = model.revealed !== null && model.revealed.sourceId === source.id ? model.revealed : null
	const timeZone = inputs.context.timeZone
	const tab = effectiveTab(source, model.tab)
	return dashboardPage(
		h,
		{
			titleContent: detailTitle(h, {
				kind: [
					"Source",
					platformMeta(source.platform).label,
					source.is_default
						? "Default"
						: integrationPlatformOf(source) === null
							? null
							: "Integration",
				],
				title: [source.name],
				adornment: platformTile(h, source.platform, "sm"),
				meta: [
					sourceStatusBadge(h, source, { nowMs }),
					...(source.key_prefix === null
						? []
						: [
								h.span(
									[h.Class("text-muted-foreground font-mono text-xs")],
									[source.key_prefix, "…"],
								),
							]),
				],
			}),
			actions: headerActions(h, model, source, timeZone),
			tabs: tabs(h, source, tab),
			gap: "md",
		},
		[
			...(shown !== null && shown.rolled ? [rolledBanner(h, model, shown.secret)] : []),
			...(tab === "overview" ? [overviewTab(h, model, source, timeZone, nowMs)] : []),
			...(tab === "setup" ? [setupTab(h, model, source, shown)] : []),
			...(tab === "connection"
				? [connectionPart(h, model, source, timeZone, "card") ?? loading(h)]
				: []),
			...(tab === "settings" ? [settingsTab(h, model, source)] : []),
		],
	)
}

const body = (h: H, model: Model, inputs: PageViewInputs): Html => {
	if (model.sourceId === null) return dashboardPage(h, {}, [notFound(h)])
	const nowMs = model.nowMs
	return AsyncData.match(model.list.data, {
		onIdle: () => dashboardPage(h, {}, [loading(h)]),
		onLoading: () => dashboardPage(h, {}, [loading(h)]),
		onFailure: (failure) =>
			dashboardPage(h, {}, [errorState(h, { failure, title: "Couldn't load this source" })]),
		onStale: ({ error }) =>
			dashboardPage(h, {}, [errorState(h, { failure: error, title: "Couldn't load this source" })]),
		onSuccess: () => loaded(h, model, inputs, nowMs),
		onRefreshing: () => loaded(h, model, inputs, nowMs),
	})
}

const loaded = (h: H, model: Model, inputs: PageViewInputs, nowMs: number | null): Html =>
	Option.match(sourceOf(model), {
		onNone: () => dashboardPage(h, {}, [notFound(h)]),
		onSome: (source) =>
			nowMs === null ? dashboardPage(h, {}, [loading(h)]) : found(h, model, source, inputs, nowMs),
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: BAR_CHART_TOKENS }))],
		[body(h, model, inputs)],
	),
)

export const breadcrumbsOf = (model: Model): ReadonlyArray<BreadcrumbEntry> => [
	{ label: "Sources", href: SOURCES_HREF },
	{
		label:
			model.sourceId === null
				? "Not found"
				: Option.match(sourceOf(model), { onNone: () => "Source", onSome: (source) => source.name }),
	},
]
