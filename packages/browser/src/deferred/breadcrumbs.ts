// The trail that led to an error: the last clicks, inputs, navigations and
// console lines, held in memory and exported only when an error is recorded,
// as OTel log records linked to the error's span. Also forwards chosen console
// levels as logs straight away (`logs.captureConsole`).
import { onSessionEvent, scrubUrl, type SessionEvent } from "@maple/browser-session"
import { installConsoleCapture } from "@maple/browser-session/console"
import type { SpanContext } from "@opentelemetry/api"
import { emitLog, Severity } from "../logs"

import type { ConsoleLevel } from "../config"

const MAX_CRUMBS = 50

interface Crumb {
	readonly timestamp: number
	readonly type: SessionEvent["type"]
	readonly level?: string | undefined
	readonly message?: string | undefined
	readonly target?: string | undefined
	readonly url?: string | undefined
}

const severityOf = (level: string | undefined): { number: number; text: keyof typeof Severity } => {
	if (level === "error") return { number: Severity.ERROR, text: "ERROR" }
	if (level === "warn") return { number: Severity.WARN, text: "WARN" }
	if (level === "debug") return { number: Severity.DEBUG, text: "DEBUG" }
	return { number: Severity.INFO, text: "INFO" }
}

let crumbs: Crumb[] = []
let active = false

function push(crumb: Crumb): void {
	crumbs.push(crumb)
	if (crumbs.length > MAX_CRUMBS) crumbs.shift()
}

function emitConsole(
	level: string | undefined,
	message: string,
	timestamp: number,
	spanContext?: SpanContext,
): void {
	const severity = severityOf(level)
	emitLog({
		severityNumber: severity.number,
		severityText: severity.text,
		body: message,
		timestamp,
		spanContext,
		attributes: {
			"maple.log.source": "console",
			...(spanContext ? { "maple.breadcrumb.type": "console" } : undefined),
		},
	})
}

export interface BreadcrumbOptions {
	/** Keep a trail for errors. */
	readonly breadcrumbs: boolean
	/** Console levels exported as logs as they happen, instead of only as breadcrumbs. */
	readonly captureConsole: ReadonlyArray<ConsoleLevel>
}

/** Start collecting. Returns a stop. */
export function startBreadcrumbs(options: BreadcrumbOptions): () => void {
	if (!options.breadcrumbs && options.captureConsole.length === 0) return () => {}
	active = true
	const forwarded = new Set<string>(options.captureConsole)
	const stopEvents = options.breadcrumbs
		? onSessionEvent((ev) => {
				// Console comes from this module's own capture, which runs whether or not replay records.
				if (!active || (ev.type !== "click" && ev.type !== "input" && ev.type !== "navigation"))
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
		if (!active || ev.message === undefined) return
		const timestamp = Date.now()
		if (ev.level !== undefined && forwarded.has(ev.level)) {
			emitConsole(ev.level, ev.message, timestamp)
			return
		}
		if (options.breadcrumbs) push({ timestamp, type: "console", level: ev.level, message: ev.message })
	})
	return () => {
		active = false
		crumbs = []
		stopEvents()
		stopConsole()
	}
}

/** Export the trail so far, linked to the error's span, and start a new one. */
export function flushBreadcrumbs(spanContext: SpanContext): void {
	if (crumbs.length === 0) return
	const trail = crumbs
	crumbs = []
	for (const crumb of trail) {
		if (crumb.type === "console") {
			emitConsole(crumb.level, crumb.message ?? "", crumb.timestamp, spanContext)
			continue
		}
		emitLog({
			eventName: "maple.browser.breadcrumb",
			severityNumber: Severity.INFO,
			severityText: "INFO",
			body: [crumb.type, crumb.target, crumb.message].filter(Boolean).join(" "),
			timestamp: crumb.timestamp,
			spanContext,
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
	active = false
}
