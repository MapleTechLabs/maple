import { StatusPageComponentStatus, UptimeMonitorId } from "@maple/domain"
import type { V2StatusPage, V2StatusPageComponent, V2StatusPageIncident } from "@maple/domain/http/v2"
import { previewSnapshot } from "@maple/status-page"
import { TONE_FILL } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Option, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { segmentedSelect } from "../../../ui/segmented-select"
import {
	COMPONENT_STATUS_LABEL,
	COMPONENT_STATUS_TONE,
	componentStatus,
	isOpenIncident,
} from "../shared/derive"
import {
	daysOf,
	isListedIncident,
	previewDocument,
	previewFrame,
	previewTheme,
	toSnapshotIncident,
} from "../shared/preview"
import { Message } from "./message"
import type { Model } from "./model"
import { componentsOf, incidentsOf, monitorsOf } from "./reads"
import { addPanel, componentPanel, composerPanel, incidentPanel, type TimeInputs } from "./view-panel"

// The page itself as the editor: a sidebar beside the preview. The sidebar lists what is on the
// page; an opened component, incident or Add takes its place. Below `lg` the sidebar stacks on top.

type H = HtmlBuilder<Message>

const decodeMonitorId = Schema.decodeUnknownOption(UptimeMonitorId)
const decodeStatus = Schema.decodeUnknownOption(StatusPageComponentStatus)

/** The component as the panel's unsaved inputs have it, so the preview follows every keystroke. */
const asEdited = (model: Model, component: V2StatusPageComponent) => {
	const form = model.componentForm
	if (model.panel?._tag !== "Component" || form.editingId !== component.id) return component
	return {
		...component,
		name: form.name.trim() === "" ? component.name : form.name.trim(),
		group: form.group.trim() === "" ? null : form.group.trim(),
		monitor_id: Option.getOrNull(decodeMonitorId(form.monitorId)),
		manual_status: Option.getOrNull(decodeStatus(form.manualStatus)),
		show_uptime: form.showUptime,
	}
}

/** What the preview outlines: the open component or incident, or the composer's components. */
export const selectedIds = (model: Model): ReadonlyArray<string> => {
	const panel = model.panel
	if (panel === null) return []
	switch (panel._tag) {
		case "Component":
			return [panel.componentId]
		case "Incident":
			return [panel.incidentId]
		case "Compose":
			return model.incidentForm.componentIds
		case "Add":
			return []
	}
}

/** The saved page as visitors get it, with the monitors' history and the panel's edits. */
export const canvasDocument = (model: Model, page: V2StatusPage): string => {
	const nowMs = model.nowMs ?? 0
	const monitors = monitorsOf(model)
	const snapshot = previewSnapshot({
		pageId: page.id,
		page: {
			name: page.name,
			slug: page.slug,
			description: page.description,
			websiteUrl: page.website_url,
			logoUrl: page.logo_url,
			privacyUrl: page.privacy_url,
			termsUrl: page.terms_url,
			showPoweredBy: page.show_powered_by,
			theme: previewTheme(page.theme, model.previewScheme),
		},
		components: componentsOf(model).map((saved) => {
			const component = asEdited(model, saved)
			return {
				id: component.id,
				name: component.name,
				description: component.description,
				group: component.group,
				monitorStatus:
					monitors.find((monitor) => monitor.id === component.monitor_id)?.state.status ?? null,
				manualStatus: component.manual_status,
				showUptime: component.show_uptime,
				monitored: component.monitor_id !== null,
				days: daysOf(model.previewHistory, component.monitor_id),
			}
		}),
		incidents: incidentsOf(model)
			.filter((incident) => isListedIncident(incident, nowMs))
			.map(toSnapshotIncident),
		nowMs,
	})
	return previewDocument({ snapshot, nowMs, isSelectable: true, selectedIds: selectedIds(model) })
}

// ON THIS PAGE

const statusDot = (h: H, status: StatusPageComponentStatus): Html =>
	h.span(
		[
			h.AriaHidden(true),
			h.Class(cn("inline-block size-2 shrink-0 rounded-xs", TONE_FILL[COMPONENT_STATUS_TONE[status]])),
		],
		[],
	)

const itemClass = (isSelected: boolean) =>
	cn(
		"flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
		isSelected
			? "bg-muted font-medium text-foreground"
			: "text-muted-foreground hover:bg-muted/50 hover:text-foreground active:bg-muted/50 active:text-foreground",
	)

const componentItem = (
	h: H,
	model: Model,
	component: V2StatusPageComponent,
	position: Readonly<{ isFirst: boolean; isLast: boolean }>,
): Html => {
	const status = componentStatus(component, monitorsOf(model), incidentsOf(model))
	const isSelected = model.panel?._tag === "Component" && model.panel.componentId === component.id
	return h.li(
		[h.Key(component.id), h.Class("group flex items-center gap-1")],
		[
			h.button(
				[
					h.Type("button"),
					h.Id(`status-page-item-${component.id}`),
					h.AriaPressed(isSelected ? "true" : "false"),
					h.OnClick(Message.ClickedComponent({ componentId: component.id })),
					h.Class(itemClass(isSelected)),
				],
				[
					statusDot(h, status),
					h.span([h.Class("truncate")], [component.name]),
					h.span([h.Class("sr-only")], [`: ${COMPONENT_STATUS_LABEL[status]}`]),
					...(component.group === null
						? []
						: [
								h.span(
									[h.Class("ml-auto truncate font-mono text-[11px] text-muted-foreground")],
									[component.group],
								),
							]),
				],
			),
			...(model.isAdmin
				? [
						h.div(
							[
								h.Class(
									"flex shrink-0 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100",
								),
							],
							[
								iconButton(
									h,
									{
										label: `Move ${component.name} up`,
										size: "icon-2xs",
										isDisabled: position.isFirst || model.isReordering,
										attributes: [
											h.OnClick(
												Message.ClickedMoveComponent({
													componentId: component.id,
													offset: -1,
												}),
											),
										],
									},
									[icon(h, "ChevronUpIcon")],
								),
								iconButton(
									h,
									{
										label: `Move ${component.name} down`,
										size: "icon-2xs",
										isDisabled: position.isLast || model.isReordering,
										attributes: [
											h.OnClick(
												Message.ClickedMoveComponent({
													componentId: component.id,
													offset: 1,
												}),
											),
										],
									},
									[icon(h, "ChevronDownIcon")],
								),
							],
						),
					]
				: []),
		],
	)
}

const incidentItem = (h: H, model: Model, incident: V2StatusPageIncident): Html => {
	const isSelected = model.panel?._tag === "Incident" && model.panel.incidentId === incident.id
	return h.li(
		[h.Key(incident.id)],
		[
			h.button(
				[
					h.Type("button"),
					h.Id(`status-page-item-${incident.id}`),
					h.AriaPressed(isSelected ? "true" : "false"),
					h.OnClick(Message.ClickedIncident({ incidentId: incident.id })),
					h.Class(itemClass(isSelected)),
				],
				[
					icon(h, incident.kind === "incident" ? "CircleWarningIcon" : "CalendarIcon", {
						size: 14,
						className: isOpenIncident(incident) ? "text-severity-warn" : "text-muted-foreground",
					}),
					h.span([h.Class("truncate")], [incident.title]),
					...(incident.published
						? []
						: [
								h.span(
									[h.Class("ml-auto font-mono text-[11px] text-muted-foreground")],
									["Draft"],
								),
							]),
				],
			),
		],
	)
}

const onThisPage = (h: H, model: Model): Html => {
	const components = componentsOf(model)
	const open = incidentsOf(model).filter(isOpenIncident)
	const recent = incidentsOf(model)
		.filter((incident) => !isOpenIncident(incident))
		.slice(0, 5)
	return h.nav(
		[
			h.Id("status-page-on-this-page"),
			h.Tabindex(-1),
			h.AriaLabel("On this page"),
			h.Class("flex min-w-0 flex-col gap-5 outline-none"),
		],
		[
			h.div(
				[h.Class("flex flex-col gap-1.5")],
				[
					eyebrow(h, { as: "h2", className: "px-2" }, ["On this page"]),
					components.length === 0
						? h.p(
								[h.Class("px-2 text-xs text-muted-foreground")],
								[
									model.isAdmin
										? "Nothing yet. Add a monitor and visitors see its status and uptime."
										: "No monitors on this page yet.",
								],
							)
						: h.ul(
								[h.AriaLabel("Components"), h.Class("flex flex-col gap-0.5")],
								components.map((component, index) =>
									componentItem(h, model, component, {
										isFirst: index === 0,
										isLast: index === components.length - 1,
									}),
								),
							),
					...(model.isAdmin
						? [
								button(
									h,
									{
										size: "sm",
										variant: "outline",
										className: "mt-1.5",
										attributes: [h.OnClick(Message.ClickedAddComponent())],
									},
									[icon(h, "PlusIcon"), "Add monitor"],
								),
							]
						: []),
				],
			),
			h.div(
				[h.Class("flex flex-col gap-1.5")],
				[
					eyebrow(h, { as: "h2", className: "px-2" }, ["Incidents"]),
					open.length + recent.length === 0
						? h.p(
								[h.Class("px-2 text-xs text-muted-foreground")],
								["Nothing posted. Post incident when something breaks."],
							)
						: h.ul(
								[h.AriaLabel("Incidents"), h.Class("flex flex-col gap-0.5")],
								[...open, ...recent].map((incident) => incidentItem(h, model, incident)),
							),
				],
			),
		],
	)
}

const panelView = (h: H, model: Model, time: TimeInputs): ReadonlyArray<Html> => {
	const panel = model.panel
	if (panel === null) return []
	switch (panel._tag) {
		case "Component": {
			const component = componentsOf(model).find((row) => row.id === panel.componentId)
			return component === undefined ? [] : [componentPanel(h, model, component)]
		}
		case "Incident": {
			const incident = incidentsOf(model).find((row) => row.id === panel.incidentId)
			return incident === undefined ? [] : [incidentPanel(h, model, incident, time)]
		}
		case "Compose":
			return [composerPanel(h, model, time.timeZone)]
		case "Add":
			return [addPanel(h, model)]
	}
}

const previewColumn = (h: H, model: Model, page: V2StatusPage): Html =>
	h.section(
		[h.AriaLabel("Page preview"), h.Class("flex min-w-0 flex-col gap-2")],
		[
			h.div(
				[h.Class("flex min-h-7 items-center justify-between gap-3")],
				[
					h.p(
						[h.Class("text-xs text-muted-foreground")],
						["Click a component or incident to edit it."],
					),
					...(page.theme.appearance === "auto"
						? [
								segmentedSelect(h, {
									size: "xs",
									ariaLabel: "Preview mode",
									value: model.previewScheme,
									onChange: (scheme) => Message.PickedPreviewScheme({ scheme }),
									options: [
										{ value: "light", label: "Light" },
										{ value: "dark", label: "Dark" },
									],
								}),
							]
						: []),
				],
			),
			previewFrame(h, {
				title: `${page.name} as visitors see it`,
				document: canvasDocument(model, page),
				isSelectable: true,
				className: "h-[640px] lg:h-[calc(100vh-16rem)] lg:min-h-[520px]",
			}),
		],
	)

export const canvas = (h: H, model: Model, page: V2StatusPage, time: TimeInputs): Html => {
	const panel = panelView(h, model, time)
	return h.div(
		[
			h.Class(
				"grid items-start gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[22rem_minmax(0,1fr)]",
			),
		],
		[
			h.div(
				[h.Class("min-w-0 lg:sticky lg:top-0")],
				panel.length === 0 ? [onThisPage(h, model)] : panel,
			),
			h.div([h.Class("min-w-0")], [previewColumn(h, model, page)]),
		],
	)
}
