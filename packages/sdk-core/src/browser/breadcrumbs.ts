// The trail that led to an error: the last clicks, inputs, navigations and
// console lines, held in memory and exported only when an error is recorded,
// as log records linked to the error's span. Also forwards chosen console
// levels as logs straight away (`logs.captureConsole`).
import { onSessionEvent, scrubUrl, type SessionEvent } from "@maple/browser-session"
import { installConsoleCapture } from "@maple/browser-session/console"
import { type EmitLog, Severity, severityOf, type SpanLink } from "../log-record"
import type { ConsoleLevel } from "../options"

const MAX_CRUMBS = 50

interface Crumb {
	readonly timestamp: number
	readonly type: SessionEvent["type"]
	readonly level?: string | undefined
	readonly message?: string | undefined
	readonly target?: string | undefined
	readonly url?: string | undefined
}

let crumbs: Crumb[] = []
let emit: EmitLog | undefined

function push(crumb: Crumb): void {
	// Typing is one `input` per keystroke: keep one crumb per field, or a message evicts the whole trail.
	const last = crumbs.at(-1)
	if (
		crumb.type === "input" &&
		crumb.target !== undefined &&
		last?.type === "input" &&
		last.target === crumb.target
	) {
		crumbs[crumbs.length - 1] = crumb
		return
	}
	crumbs.push(crumb)
	if (crumbs.length > MAX_CRUMBS) crumbs.shift()
}

function emitConsole(
	sink: EmitLog,
	level: string | undefined,
	message: string,
	timestamp: number,
	link?: SpanLink,
): void {
	const severity = severityOf(level)
	sink({
		severityNumber: severity.number,
		severityText: severity.text,
		body: message,
		timestamp,
		link,
		attributes: {
			"maple.log.source": "console",
			...(link ? { "maple.breadcrumb.type": "console" } : undefined),
		},
	})
}

export interface BreadcrumbOptions {
	/** Keep a trail for errors. */
	readonly breadcrumbs: boolean
	/** Console levels exported as logs as they happen, instead of only as breadcrumbs. */
	readonly captureConsole: ReadonlyArray<ConsoleLevel>
}

/** Start collecting into `sink`. Returns a stop. */
export function startBreadcrumbs(sink: EmitLog, options: BreadcrumbOptions): () => void {
	if (!options.breadcrumbs && options.captureConsole.length === 0) return () => {}
	emit = sink
	const live = (): boolean => emit === sink
	const forwarded = new Set<string>(options.captureConsole)
	const stopEvents = options.breadcrumbs
		? onSessionEvent((ev) => {
				// Console comes from this module's own capture, which runs whether or not replay records.
				if (!live() || (ev.type !== "click" && ev.type !== "input" && ev.type !== "navigation"))
					return
				push({
					timestamp: ev.timestamp ?? Date.now(),
					type: ev.type,
					target: ev.targetSelector,
					message: ev.targetText,
					url: ev.url ?? location.href,
				})
			})
		: () => {}
	const stopConsole = installConsoleCapture((ev) => {
		if (!live() || ev.message === undefined) return
		const timestamp = Date.now()
		if (ev.level !== undefined && forwarded.has(ev.level)) {
			emitConsole(sink, ev.level, ev.message, timestamp)
			return
		}
		if (options.breadcrumbs) push({ timestamp, type: "console", level: ev.level, message: ev.message })
	})
	return () => {
		if (live()) {
			emit = undefined
			crumbs = []
		}
		stopEvents()
		stopConsole()
	}
}

/** Export the trail so far, linked to the error's span, and start a new one. */
export function flushBreadcrumbs(link: SpanLink): void {
	const sink = emit
	if (!sink || crumbs.length === 0) return
	const trail = crumbs
	crumbs = []
	for (const crumb of trail) {
		if (crumb.type === "console") {
			emitConsole(sink, crumb.level, crumb.message ?? "", crumb.timestamp, link)
			continue
		}
		sink({
			eventName: "maple.browser.breadcrumb",
			severityNumber: Severity.INFO,
			severityText: "INFO",
			body: [crumb.type, crumb.target, crumb.message].filter(Boolean).join(" "),
			timestamp: crumb.timestamp,
			link,
			attributes: {
				"maple.breadcrumb.type": crumb.type,
				...(crumb.target ? { "maple.breadcrumb.target": crumb.target } : undefined),
				...(crumb.url ? { "url.full": scrubUrl(crumb.url) } : undefined),
			},
		})
	}
}

/** Test seam. */
export function resetBreadcrumbsForTests(): void {
	crumbs = []
	emit = undefined
}
