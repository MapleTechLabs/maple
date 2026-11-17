import { StatusPageComponentStatus, UptimeMonitorId } from "@maple/domain"
import type { V2StatusPage, V2StatusPageComponent } from "@maple/domain/http/v2"
import type { StatusPageSnapshot } from "@maple/domain/status-page"
import { pageTitle, previewSnapshot } from "@maple/status-page"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { Option, Schema, Array as Arr, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { browserTabMockup } from "@maple/views/ui/page-mockup"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { monitorStatusOf } from "../shared/derive"
import { orNull, type SettingsForm, settingsFormOf, themeOf } from "../shared/form"
import {
	daysOf,
	isListedIncident,
	previewControls,
	previewDocument,
	previewExampleNote,
	previewFrame,
	type PreviewState,
	previewTheme,
	simulatePreview,
	toSnapshotIncident,
} from "../shared/preview"
import { Message } from "./message"
import type { Model } from "./model"
import { componentsOf, incidentsOf, monitorsOf, statusReadsFailed, statusReadsReady } from "./reads"
import { pageUrlOf } from "./update-domain"

// The Live page tab: the page as visitors get it, full width; a click on a component or incident
// opens it where it is edited. Also the snapshot every smaller preview of a setting renders from.

type H = HtmlBuilder<Message>

const decodeMonitorId = Schema.decodeUnknownOption(UptimeMonitorId)
const decodeStatus = Schema.decodeUnknownOption(StatusPageComponentStatus)

/** The component as its open form has it, so previews follow every keystroke. */
const asEdited = (model: Model, component: V2StatusPageComponent): V2StatusPageComponent => {
	const form = model.componentForm
	if (model.panel?._tag !== "Component" || form.editingId !== component.id) return component
	return {
		...component,
		name: Str.trim(form.name) === "" ? component.name : Str.trim(form.name),
		description: orNull(form.description),
		group: orNull(form.group),
		monitor_id: Option.getOrNull(decodeMonitorId(form.monitorId)),
		manual_status: Option.getOrNull(decodeStatus(form.manualStatus)),
		show_uptime: form.showUptime,
	}
}

const nowOf = (model: Model, page: V2StatusPage): number => model.nowMs ?? toEpochMs(page.updated_at)

/** The page as the editor would publish it: `form`'s fields, the open component's edits, in `state`. */
export const draftSnapshot = (
	model: Model,
	page: V2StatusPage,
	form: SettingsForm,
	state: PreviewState,
): StatusPageSnapshot => {
	const nowMs = nowOf(model, page)
	const monitors = monitorsOf(model)
	const shown = simulatePreview(state, {
		components: Arr.map(componentsOf(model), (saved) => {
			const component = asEdited(model, saved)
			return {
				id: component.id,
				name: component.name,
				description: component.description,
				group: component.group,
				monitorStatus: monitorStatusOf(monitors, component.monitor_id),
				manualStatus: component.manual_status,
				showUptime: component.show_uptime,
				monitored: component.monitor_id !== null,
				days: daysOf(model.previewHistory, component.monitor_id),
			}
		}),
		incidents: Arr.map(
			Arr.filter(incidentsOf(model), (incident) => isListedIncident(incident, nowMs)),
			toSnapshotIncident,
		),
		nowMs,
	})
	return previewSnapshot({
		pageId: page.id,
		page: {
			name: draftName(page, form),
			slug: form.slug,
			description: orNull(form.description),
			websiteUrl: orNull(form.websiteUrl),
			logoUrl: orNull(form.logoUrl),
			logoDarkUrl: orNull(form.logoDarkUrl),
			faviconUrl: orNull(form.faviconUrl),
			supportUrl: orNull(form.supportUrl),
			privacyUrl: orNull(form.privacyUrl),
			termsUrl: orNull(form.termsUrl),
			customDomain: null,
			visibility: page.visibility,
			showPoweredBy: form.showPoweredBy,
			theme: previewTheme(themeOf(form.theme), model.previewScheme),
		},
		components: shown.components,
		incidents: shown.incidents,
		nowMs,
	})
}

/** The name the unsaved `form` gives the page; the saved one while the field is empty. */
export const draftName = (page: V2StatusPage, form: SettingsForm): string => orNull(form.name) ?? page.name

/**
 * The page's browser tab (title, favicon, address) as the unsaved `form` has them: what the page
 * preview beside Settings cannot show.
 */
export const tabPreview = (h: H, page: V2StatusPage, form: SettingsForm, address: string | null): Html =>
	browserTabMockup(
		h,
		{ title: pageTitle(draftName(page, form)), iconUrl: orNull(form.faviconUrl), address },
		[],
	)

/**
 * The whole page as the unsaved `form` would publish it, beside Settings: a 2x document scaled to
 * half so the narrow column shows the desktop layout, scrolling inside its frame. Waits for the
 * statuses like any preview.
 */
export const settingsPagePreview = (h: H, model: Model, page: V2StatusPage, form: SettingsForm): Html =>
	vstack(h, { gap: "1.5", as: "section", attributes: [h.AriaLabel("Page preview")] }, [
		typography(h, { size: "xs", tone: "muted", as: "p" }, ["Your page with these settings"]),
		!statusReadsReady(model)
			? statusReadsFailed(model)
				? typography(h, { size: "xs", tone: "muted", as: "p" }, [
						"No preview: the page's components didn't load.",
					])
				: skeleton(h, "h-[calc(100vh-14rem)] w-full rounded-lg")
			: h.div(
					[
						h.Class(
							"relative h-[calc(100vh-14rem)] min-h-96 overflow-hidden rounded-lg border bg-background",
						),
					],
					[
						// Not inert like a fragment: visitors scroll the page, so the preview scrolls too.
						previewFrame(h, {
							title: `${draftName(page, form)} with these settings`,
							document: previewDocument({
								snapshot: draftSnapshot(model, page, form, "live"),
								nowMs: nowOf(model, page),
								isSelectable: false,
								publicUrl: pageUrlOf(model, page),
							}),
							className:
								"absolute top-0 left-0 h-[200%] w-[200%] origin-top-left scale-50 rounded-none border-0",
						}),
					],
				),
	])

/** The saved page as visitors get it, with the monitors' history; components and incidents click. */
export const canvasDocument = (model: Model, page: V2StatusPage): string =>
	previewDocument({
		snapshot: draftSnapshot(model, page, settingsFormOf(page), model.previewState),
		nowMs: nowOf(model, page),
		isSelectable: true,
		publicUrl: pageUrlOf(model, page),
	})

export const livePage = (h: H, model: Model, page: V2StatusPage): Html =>
	vstack(h, { gap: "2", shrink: true, as: "section", attributes: [h.AriaLabel("Page preview")] }, [
		hstack(h, { gap: "3", justify: "between", wrap: true, className: "min-h-7" }, [
			typography(h, { size: "xs", tone: "muted", as: "p" }, [
				"Click a component or incident to edit it.",
			]),
			previewControls(h, {
				state: model.previewState,
				width: model.previewWidth,
				scheme: page.theme.appearance === "auto" ? model.previewScheme : null,
				onState: (state) => Message.PickedPreviewState({ state }),
				onWidth: (width) => Message.PickedPreviewWidth({ width }),
				onScheme: (scheme) => Message.PickedPreviewScheme({ scheme }),
			}),
		]),
		// Above the frame: the frame fills the viewport, so a note under it is never seen.
		...previewExampleNote(h, model.previewState),
		previewFrame(h, {
			title: `${page.name} as visitors see it`,
			document: canvasDocument(model, page),
			isSelectable: true,
			width: model.previewWidth,
			className: "h-[640px] lg:h-[calc(100vh-16rem)] lg:min-h-[520px]",
		}),
	])
