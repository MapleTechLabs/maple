import { UptimeMonitorId } from "@maple/domain"
import type { StatusPagePreviewParams, V2StatusPageIncident } from "@maple/domain/http/v2"
import {
	isListedIncident as isListedSnapshotIncident,
	StatusPageDayBar,
	type StatusPageSnapshot,
	type StatusPageSnapshotIncident,
	type StatusPageTheme,
} from "@maple/domain/status-page"
import { renderPage } from "@maple/status-page"
import { cn } from "@maple/ui/lib/utils"
import { Option, Schema, Stream, Array as Arr, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { isoMs } from "../../alerts/shared/time"

// The live preview: the public renderer's page in a sandboxed frame, with the monitors' real
// history, and in the editor a click on a component or incident posted back to select it.

/** The scheme the preview shows an Auto page in; the page itself follows each visitor. */
export const PreviewScheme = Schema.Literals(["light", "dark"])
export type PreviewScheme = typeof PreviewScheme.Type

/** Each monitor's daily bars as the preview endpoint last read them. */
export const PreviewHistory = Schema.Array(
	Schema.Struct({ monitorId: UptimeMonitorId, days: Schema.Array(StatusPageDayBar) }),
)
export type PreviewHistory = typeof PreviewHistory.Type

/** The preview answers one component per one sent, in order: pair them back up by monitor. */
export const historyFrom = (sent: StatusPagePreviewParams, snapshot: StatusPageSnapshot): PreviewHistory =>
	Arr.flatMap(sent.components, (component, index) => {
		const days = snapshot.components[index]?.days ?? []
		return component.monitor_id === null || component.monitor_id === undefined || days.length === 0
			? []
			: [{ monitorId: component.monitor_id, days }]
	})

export const daysOf = (history: PreviewHistory, monitorId: UptimeMonitorId | null) =>
	monitorId === null
		? undefined
		: Option.getOrUndefined(
				Option.map(
					Arr.findFirst(history, (entry) => entry.monitorId === monitorId),
					(entry) => entry.days,
				),
			)

/** Auto pages preview in the picked scheme, with the overrides Auto ignores left out. */
export const previewTheme = (theme: StatusPageTheme, scheme: PreviewScheme): StatusPageTheme =>
	theme.appearance === "auto"
		? { ...theme, appearance: scheme, background: null, text: null, card: null, border: null }
		: theme

const msOrNull = (value: string | null): number | null => (value === null ? null : isoMs(value))

/** Whether visitors see the incident now, by the publisher's own rule. */
export const isListedIncident = (incident: V2StatusPageIncident, nowMs: number): boolean =>
	isListedSnapshotIncident(
		{
			published: incident.published,
			kind: incident.kind,
			status: incident.status,
			scheduledEnd: msOrNull(incident.scheduled_end),
			resolvedAt: msOrNull(incident.resolved_at),
		},
		nowMs,
	)

export const toSnapshotIncident = (incident: V2StatusPageIncident): StatusPageSnapshotIncident => ({
	id: incident.id,
	kind: incident.kind,
	title: incident.title,
	impact: incident.impact,
	status: incident.status,
	startedAt: isoMs(incident.started_at),
	resolvedAt: msOrNull(incident.resolved_at),
	scheduledStart: msOrNull(incident.scheduled_start),
	scheduledEnd: msOrNull(incident.scheduled_end),
	componentIds: incident.component_ids,
	openedByOverlayEntryId: null,
	updates: Arr.map(incident.updates, (update) => ({
		id: update.id,
		status: update.status,
		body: update.body,
		at: isoMs(update.created_at),
		source: update.source,
		overlayEntryId: null,
	})).sort((a, b) => b.at - a.at),
})

// SELECTION

/** What a click in the preview selects. */
export const PreviewSelection = Schema.Struct({
	kind: Schema.Literals(["component", "incident"]),
	id: Schema.String,
})
export type PreviewSelection = typeof PreviewSelection.Type

const SelectMessage = Schema.Struct({
	type: Schema.Literal("select"),
	kind: PreviewSelection.fields.kind,
	id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u)),
})
const decodeSelect = Schema.decodeUnknownOption(SelectMessage)

/** A preview message's selection; anything not exactly `{ type: "select", kind, id }` is none. */
export const selectionOf = (data: unknown): Option.Option<PreviewSelection> =>
	Option.map(decodeSelect(data), ({ kind, id }) => ({ kind, id }))

const isSafeId = (id: string) => /^[A-Za-z0-9_-]{1,64}$/u.test(id)

/** Inert in the frame: it only posts what was clicked; the frame has no same-origin access. */
const SELECT_SCRIPT = `(function(){var q="[data-component-id],[data-incident-id]";document.addEventListener("click",function(e){var t=e.target&&e.target.closest?e.target.closest(q):null;if(!t)return;e.preventDefault();var c=t.getAttribute("data-component-id");parent.postMessage(c?{type:"select",kind:"component",id:c}:{type:"select",kind:"incident",id:t.getAttribute("data-incident-id")},"*")});var s=document.querySelector("[data-sp-first]");if(s)window.scrollTo(0,Math.max(0,s.getBoundingClientRect().top+window.scrollY-window.innerHeight/3))})();`

const selectionStyles = (selectedIds: ReadonlyArray<string>): string => {
	const ids = Arr.filter(selectedIds, isSafeId)
	const selected = Arr.join(
		Arr.flatMap(ids, (id) => [`[data-component-id="${id}"]`, `[data-incident-id="${id}"]`]),
		",",
	)
	return Arr.join(
		[
			`[data-component-id],[data-incident-id]{cursor:pointer;border-radius:6px;transition:outline-color .12s}`,
			`[data-component-id]:hover,[data-incident-id]:hover{outline:1px dashed color-mix(in srgb,currentColor 35%,transparent);outline-offset:3px}`,
			selected === "" ? "" : `${selected}{outline:2px solid #3b82f6;outline-offset:3px}`,
		],
		"",
	)
}

/** Marks the first selected element so the frame scrolls its own view to it after a reload. */
const markFirst = (html: string, selectedIds: ReadonlyArray<string>): string => {
	const found = Arr.findFirst(selectedIds, isSafeId)
	if (Option.isNone(found)) return html
	const first = found.value
	const attr = Str.includes(`data-component-id="${first}"`)(html)
		? `data-component-id="${first}"`
		: `data-incident-id="${first}"`
	return Str.replace(attr, `${attr} data-sp-first`)(html)
}

export type PreviewDocumentOptions = Readonly<{
	snapshot: StatusPageSnapshot
	nowMs: number
	/** The editor's preview: components and incidents can be clicked, and the selection drawn. */
	isSelectable: boolean
	selectedIds: ReadonlyArray<string>
}>

/** The public page as the renderer draws it, plus, when selectable, the selection script. */
export const previewDocument = (options: PreviewDocumentOptions): string => {
	const html = renderPage(options.snapshot, { _tag: "live", updatedAt: options.nowMs }, options.nowMs, {
		preview: options.isSelectable,
	})
	if (!options.isSelectable) return html
	const extra = `<style>${selectionStyles(options.selectedIds)}</style><script>${SELECT_SCRIPT}</script>`
	return Str.replace("</body>", `${extra}</body>`)(markFirst(html, options.selectedIds))
}

export const PREVIEW_FRAME_ID = "status-page-preview-frame"

/**
 * The selections the editor's preview frame posts; other windows and shapes are dropped.
 * Suspended so importing this module never touches `window` (scene tests run in node).
 */
export const previewSelections: Stream.Stream<PreviewSelection> = Stream.suspend(() =>
	Stream.fromEventListener<MessageEvent>(window, "message").pipe(
		Stream.filter((event) => {
			const frame = document.getElementById(PREVIEW_FRAME_ID)
			// A sandboxed frame without `allow-same-origin` posts from the opaque origin "null".
			return (
				frame instanceof HTMLIFrameElement &&
				event.source === frame.contentWindow &&
				event.origin === "null"
			)
		}),
		Stream.flatMap((event) =>
			Option.match(selectionOf(event.data), {
				onNone: () => Stream.empty,
				onSome: (selection) => Stream.make(selection),
			}),
		),
	),
)

/** The sandboxed frame: scripts run so the page pages its bars, but it can reach nothing of ours. */
export const previewFrame = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ document: string; title: string; className?: string; isSelectable?: boolean }>,
): Html =>
	h.iframe(
		[
			...(options.isSelectable === true ? [h.Id(PREVIEW_FRAME_ID)] : []),
			h.Title(options.title),
			h.Sandbox("allow-scripts"),
			h.Srcdoc(options.document),
			h.Class(cn("block w-full rounded-lg border bg-background", options.className)),
		],
		[],
	)
