import { UptimeMonitorId } from "@maple/domain"
import type { StatusPagePreviewParams, V2StatusPageIncident } from "@maple/domain/http/v2"
import {
	isActiveIncident,
	isListedIncident as isListedSnapshotIncident,
	StatusPageDayBar,
	type StatusPagePublicSnapshot,
	type StatusPageSnapshotIncident,
	type StatusPageTheme,
} from "@maple/domain/status-page"
import { type PreviewComponent, renderPage } from "@maple/status-page"
import { cn } from "@maple/ui/lib/utils"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { Effect, Option, Schema, Stream, Array as Arr, String as Str } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { toEpochMs } from "@maple/ui/lib/time-format"

// The live preview: the public renderer's page in a sandboxed frame, with the monitors' real
// history, and in the editor a click on a component or incident posted back to open it.

/** The scheme the preview shows an Auto page in; the page itself follows each visitor. */
export const PreviewScheme = Schema.Literals(["light", "dark"])
export type PreviewScheme = typeof PreviewScheme.Type

/** Each monitor's daily bars as the preview endpoint last read them. */
export const PreviewHistory = Schema.Array(
	Schema.Struct({ monitorId: UptimeMonitorId, days: Schema.Array(StatusPageDayBar) }),
)
export type PreviewHistory = typeof PreviewHistory.Type

/** The preview answers one component per one sent, in order: pair them back up by monitor. */
export const historyFrom = (
	sent: StatusPagePreviewParams,
	snapshot: StatusPagePublicSnapshot,
): PreviewHistory =>
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

/** The width the preview is drawn at: the whole column, or a phone. */
export const PreviewWidth = Schema.Literals(["desktop", "mobile"])
export type PreviewWidth = typeof PreviewWidth.Type

/** What the preview shows: the page as it is now, or a state it is not in, to check how it reads. */
export const PreviewState = Schema.Literals(["live", "operational", "outage", "maintenance"])
export type PreviewState = typeof PreviewState.Type

const exampleIncident = (
	state: "outage" | "maintenance",
	nowMs: number,
	componentIds: ReadonlyArray<string>,
): StatusPageSnapshotIncident => {
	const startedAt = nowMs - 25 * 60_000
	const isOutage = state === "outage"
	return {
		id: "preview-example",
		kind: isOutage ? "incident" : "maintenance",
		title: isOutage ? "Example incident" : "Example maintenance",
		impact: isOutage ? "critical" : "none",
		status: isOutage ? "investigating" : "in_progress",
		startedAt,
		resolvedAt: null,
		scheduledStart: isOutage ? null : startedAt,
		scheduledEnd: isOutage ? null : nowMs + 95 * 60_000,
		componentIds,
		openedByOverlayEntryId: null,
		updates: [
			{
				id: "preview-example-update",
				status: isOutage ? "investigating" : "in_progress",
				body: isOutage
					? "This is how an incident reads to visitors. Nothing was posted."
					: "This is how maintenance reads to visitors. Nothing was scheduled.",
				at: startedAt,
				source: "dashboard",
				overlayEntryId: null,
			},
		],
	}
}

/**
 * The components and incidents the preview draws for a state. `live` passes them through; the
 * others clear what is open and, for an outage or maintenance, add an example on the first component.
 */
export const simulatePreview = (
	state: PreviewState,
	input: Readonly<{
		components: ReadonlyArray<PreviewComponent>
		incidents: ReadonlyArray<StatusPageSnapshotIncident>
		nowMs: number
	}>,
): Readonly<{
	components: ReadonlyArray<PreviewComponent>
	incidents: ReadonlyArray<StatusPageSnapshotIncident>
}> => {
	if (state === "live") return { components: input.components, incidents: input.incidents }
	const components = Arr.map(input.components, (component) => ({
		...component,
		monitorStatus: component.monitorStatus === "down" ? "up" : component.monitorStatus,
		manualStatus: null,
	}))
	const settled = Arr.filter(input.incidents, (incident) => !isActiveIncident(incident))
	return {
		components,
		incidents:
			state === "operational"
				? settled
				: [
						exampleIncident(
							state,
							input.nowMs,
							Arr.map(Arr.take(input.components, 1), (component) => component.id),
						),
						...settled,
					],
	}
}

const msOrNull = (value: string | null): number | null => (value === null ? null : toEpochMs(value))

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
	startedAt: toEpochMs(incident.started_at),
	resolvedAt: msOrNull(incident.resolved_at),
	scheduledStart: msOrNull(incident.scheduled_start),
	scheduledEnd: msOrNull(incident.scheduled_end),
	componentIds: incident.component_ids,
	openedByOverlayEntryId: null,
	updates: Arr.map(incident.updates, (update) => ({
		id: update.id,
		status: update.status,
		body: update.body,
		at: toEpochMs(update.created_at),
		source: update.source,
		overlayEntryId: null,
	})).sort((a, b) => b.at - a.at),
})

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

/** Inert in the frame: it only posts what was clicked; the frame has no same-origin access. */
const SELECT_SCRIPT = `(function(){var q="[data-component-id],[data-incident-id]";document.addEventListener("click",function(e){var t=e.target&&e.target.closest?e.target.closest(q):null;if(!t)return;e.preventDefault();var c=t.getAttribute("data-component-id");parent.postMessage(c?{type:"select",kind:"component",id:c}:{type:"select",kind:"incident",id:t.getAttribute("data-incident-id")},"*")})})();`

const SELECTABLE_STYLES = `[data-component-id],[data-incident-id]{cursor:pointer;border-radius:6px}[data-component-id]:hover,[data-incident-id]:hover{outline:1px dashed color-mix(in srgb,currentColor 35%,transparent);outline-offset:3px}`

export type PreviewDocumentOptions = Readonly<{
	snapshot: StatusPagePublicSnapshot
	nowMs: number
	/** The editor's preview: components and incidents can be clicked. */
	isSelectable: boolean
	/** Where visitors read the page, for its Slack command; `null` while no status domain is configured. */
	publicUrl: string | null
	/**
	 * The page read for real (the viewer): absolute http(s) links open in a new tab. The editor's
	 * previews keep every link in place. Its frame needs `previewFrame`'s `opensLinks` too.
	 */
	opensLinks?: boolean
}>

/**
 * A srcdoc frame resolves links against the dashboard's URL, so following one loads the dashboard
 * inside the frame. In-page links scroll instead; other links and form posts stay put, except an
 * absolute http(s) link when `opensLinks`, which opens in a new tab.
 */
const stayInFrameScript = (opensLinks: boolean): string =>
	`(function(){var o=${opensLinks};document.addEventListener("click",function(e){if(e.defaultPrevented)return;var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href");if(o&&h&&/^https?:/i.test(h)){a.target="_blank";a.rel="noopener noreferrer";return}e.preventDefault();if(h&&h.charAt(0)==="#"){var t=document.getElementById(decodeURIComponent(h.slice(1)));if(t)t.scrollIntoView({block:"start"})}});document.addEventListener("submit",function(e){e.preventDefault()})})();`

/**
 * Puts each document the editor posts into the page in place, so an edit never reloads the frame:
 * no image flashes and the scroll stays. The first document posted is the one the frame loaded;
 * each later one is diffed against the one before it, and only what changed is written to the
 * page, so what the page's script did to the rest (shown arrows, times in the visitor's zone, its
 * tooltip) is kept. Scripts in new nodes don't run.
 */
const MORPH_SCRIPT = `(function(){var P=new DOMParser(),prev=null;
function same(a,b){return a.nodeType===b.nodeType&&a.nodeName===b.nodeName}
function classes(l,a,b){a.classList.forEach(function(c){if(!b.classList.contains(c))l.classList.remove(c)});b.classList.forEach(function(c){if(!a.classList.contains(c))l.classList.add(c)})}
function attrs(l,a,b){var i,x;for(i=0;i<a.attributes.length;i++){x=a.attributes[i].name;if(x!=="class"&&!b.hasAttribute(x))l.removeAttribute(x)}for(i=0;i<b.attributes.length;i++){x=b.attributes[i];if(x.name!=="class"&&a.getAttribute(x.name)!==x.value)l.setAttribute(x.name,x.value)}classes(l,a,b)}
function patch(l,a,b){if(a.isEqualNode(b))return;if(l.nodeType!==1){l.nodeValue=b.nodeValue;return}attrs(l,a,b);kids(l,a,b)}
function kids(p,a,b){var l=Array.prototype.slice.call(p.childNodes),o=a.childNodes,n=b.childNodes,end=l[o.length]||null,i;
for(i=0;i<n.length;i++){if(i>=o.length||!l[i])p.insertBefore(document.importNode(n[i],true),end);else if(same(o[i],n[i])&&same(l[i],o[i]))patch(l[i],o[i],n[i]);else if(!o[i].isEqualNode(n[i]))p.replaceChild(document.importNode(n[i],true),l[i])}
for(i=n.length;i<o.length;i++)if(l[i])p.removeChild(l[i])}
addEventListener("message",function(e){var d=e.data;if(e.source!==parent||!d||d.type!=="document"||typeof d.html!=="string")return;var next=P.parseFromString(d.html,"text/html");if(prev)patch(document.documentElement,prev.documentElement,next.documentElement);prev=next})})();`

/** The public page as the renderer draws it, plus, when selectable, the selection script. */
export const previewDocument = (options: PreviewDocumentOptions): string => {
	const preview = options.isSelectable
	const html = renderPage(
		options.snapshot,
		{ _tag: "live", updatedAt: options.nowMs },
		options.nowMs,
		options.publicUrl === null
			? { preview, inDashboard: true }
			: { preview, inDashboard: true, publicUrl: options.publicUrl },
	)
	const stay = `<script>${stayInFrameScript(options.opensLinks === true)}</script><script>${MORPH_SCRIPT}</script>`
	if (!options.isSelectable) return Str.replace("</body>", `${stay}</body>`)(html)
	const extra = `<style>${SELECTABLE_STYLES}</style><script>${SELECT_SCRIPT}</script>${stay}`
	return Str.replace("</body>", `${extra}</body>`)(html)
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

const PREVIEW_STATES: ReadonlyArray<{ value: PreviewState; label: string }> = [
	{ value: "live", label: "Live" },
	{ value: "operational", label: "All clear" },
	{ value: "outage", label: "Outage" },
	{ value: "maintenance", label: "Maintenance" },
]

/** The preview's own switches: which state, width and (for an Auto page) scheme it draws. None is a page edit. */
export const previewControls = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		state: PreviewState
		width: PreviewWidth
		/** `null` on a page with a fixed mode: there is no scheme to pick. */
		scheme: PreviewScheme | null
		onState: (state: PreviewState) => M
		onWidth: (width: PreviewWidth) => M
		onScheme: (scheme: PreviewScheme) => M
	}>,
): Html =>
	hstack(h, { gap: "2", wrap: true, justify: "end" }, [
		segmentedSelect(h, {
			size: "xs",
			ariaLabel: "Preview state",
			value: options.state,
			onChange: options.onState,
			options: PREVIEW_STATES,
		}),
		segmentedSelect(h, {
			size: "xs",
			ariaLabel: "Preview width",
			value: options.width,
			onChange: options.onWidth,
			options: [
				{ value: "desktop", label: "Desktop" },
				{ value: "mobile", label: "Mobile" },
			],
		}),
		...(options.scheme === null
			? []
			: [
					segmentedSelect(h, {
						size: "xs",
						ariaLabel: "Preview mode",
						value: options.scheme,
						onChange: options.onScheme,
						options: [
							{ value: "light", label: "Light" },
							{ value: "dark", label: "Dark" },
						],
					}),
				]),
	])

/** Said under a preview that is not showing the live state, so an example is never read as real. */
export const previewExampleNote = <M>(h: HtmlBuilder<M>, state: PreviewState): ReadonlyArray<Html> =>
	state === "live"
		? []
		: [
				typography(h, { size: "xs", tone: "muted", as: "p" }, [
					"Showing an example state. Visitors still see the live page.",
				]),
			]

const PreviewFrameMessage = defineMessageUnion({ CompletedMountPreviewFrame: {} })

/** The frame's current document, read by `SyncPreviewFrame` (and by tests). */
const DOCUMENT_ATTRIBUTE = "data-document"

/**
 * Loads the frame's first document, then posts each new one into it as `data-document` changes,
 * for its `MORPH_SCRIPT` to put in place. The frame is sandboxed without same-origin access, so a
 * message is the only way in. Each load starts over from the document the frame loaded.
 */
const syncFrame = (frame: HTMLIFrameElement): (() => void) => {
	const current = () => frame.getAttribute(DOCUMENT_ATTRIBUTE) ?? ""
	const initial = current()
	// The frame's origin is opaque, so no target origin other than "*" reaches it.
	const post = (html: string) => frame.contentWindow?.postMessage({ type: "document", html }, "*")
	let isLoaded = false
	const onLoad = () => {
		isLoaded = true
		post(initial)
		if (current() !== initial) post(current())
	}
	const observer = new MutationObserver(() => (isLoaded ? post(current()) : undefined))
	frame.addEventListener("load", onLoad)
	observer.observe(frame, { attributes: true, attributeFilter: [DOCUMENT_ATTRIBUTE] })
	frame.srcdoc = initial
	return () => {
		observer.disconnect()
		frame.removeEventListener("load", onLoad)
	}
}

export const SyncPreviewFrame = Mount.define("SyncStatusPagePreviewFrame", {
	messages: [PreviewFrameMessage.CompletedMountPreviewFrame],
	execute: ({ element }) =>
		Effect.gen(function* () {
			if (element instanceof HTMLIFrameElement)
				yield* Effect.acquireRelease(
					Effect.sync(() => syncFrame(element)),
					(stop) => Effect.sync(stop),
				)
			return PreviewFrameMessage.CompletedMountPreviewFrame()
		}),
})

/**
 * The sandboxed frame: scripts run so the page pages its bars, but it can reach nothing of ours.
 * Its `srcdoc` is set once, as it mounts: a later document is posted in (`SyncPreviewFrame`), so
 * an edit never reloads it. The current document is its `data-document`.
 */
export const previewFrame = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		document: string
		title: string
		/** The Message the frame's Mount completes with; `update` has nothing to do for it. */
		mounted: M
		className?: string
		isSelectable?: boolean
		/** Lets the document's `opensLinks` open a new tab, outside the sandbox. */
		opensLinks?: boolean
		width?: PreviewWidth
	}>,
): Html =>
	h.iframe(
		[
			...(options.isSelectable === true ? [h.Id(PREVIEW_FRAME_ID)] : []),
			h.Title(options.title),
			h.Sandbox(
				options.opensLinks === true
					? "allow-scripts allow-popups allow-popups-to-escape-sandbox"
					: "allow-scripts",
			),
			// The Slack command's Copy button; without it the button selects the command instead.
			h.Allow("clipboard-write"),
			h.DataAttribute("document", options.document),
			h.OnMount(Mount.mapMessage(SyncPreviewFrame(), () => options.mounted)),
			h.DataAttribute("width", options.width ?? "desktop"),
			h.Class(
				cn(
					"block w-full rounded-lg border bg-background",
					options.width === "mobile" && "mx-auto max-w-sm",
					options.className,
				),
			),
		],
		[],
	)

/**
 * A small inert frame (the access gate as visitors meet it): fully sandboxed, no scripts, and it
 * takes no clicks, so nothing in it navigates the frame.
 */
export const fragmentFrame = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ document: string; title: string; className?: string }>,
): Html =>
	h.iframe(
		[
			h.Title(options.title),
			h.Sandbox(""),
			h.Tabindex(-1),
			h.Srcdoc(options.document),
			h.Class(
				cn("pointer-events-none block w-full rounded-lg border bg-background", options.className),
			),
		],
		[],
	)

/** A setting's preview: a label, then the part of the page the setting changes. */
export const onYourPage = <M>(h: HtmlBuilder<M>, preview: Html, label = "On your page"): Html =>
	vstack(h, { gap: "1.5" }, [eyebrow(h, {}, [label]), preview])
