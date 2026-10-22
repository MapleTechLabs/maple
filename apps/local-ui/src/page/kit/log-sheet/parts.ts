import { trySync } from "@maple/ui/lib/try-sync"
import { stripAnsi } from "@maple/ui/components/logs/strip-ansi"
import { SEVERITY_COLORS } from "@maple/ui/lib/severity"
import { cn } from "@maple/ui/lib/utils"
import * as CopyButton from "@maple/web/ui/copy-button"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { hrefFor } from "../../../route"
import { type Copies, copyOf } from "../copies"
import { Message } from "./message"
import type { LocalLog } from "./model"

// Pure helpers and the copy-on-click value of `LogDetailSheet`.

const SEVERITY_NUMBER_LABELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const

/** copied: `severityLabel` (packages/ui/src/components/logs/severity-badge.tsx). */
export const severityLabel = (severityText: string, severityNumber?: number): string => {
	if (severityText.trim() !== "") return severityText
	if (severityNumber !== undefined && severityNumber >= 1 && severityNumber <= 24)
		return SEVERITY_NUMBER_LABELS[Math.floor((severityNumber - 1) / 4)] ?? "UNSET"
	return "UNSET"
}

/** A faint wash of the severity colour behind the hero; unknown levels keep the plain border. */
export const heroToneStyle = (severity: string): Readonly<Record<string, string>> | undefined => {
	const key = severity.toUpperCase()
	if (!Object.hasOwn(SEVERITY_COLORS, key)) return undefined
	const color = SEVERITY_COLORS[key]
	return {
		"background-color": `color-mix(in oklch, ${color} 5%, transparent)`,
		"border-color": `color-mix(in oklch, ${color} 20%, transparent)`,
	}
}

/** The body pretty-printed when it is a JSON object or array; none otherwise. */
export const prettyJson = (value: string): Option.Option<string> => {
	const trimmed = value.trimStart()
	if (trimmed[0] !== "{" && trimmed[0] !== "[") return Option.none()
	return trySync(() => JSON.stringify(JSON.parse(value), null, 2))
}

/** What the hero shows and copies: ANSI stripped for display, pretty JSON when it is JSON. */
export const heroBody = (log: LocalLog) => {
	const body = stripAnsi(log.body ?? "")
	const pretty = prettyJson(body)
	const isJson = Option.isSome(pretty)
	const formatted = Option.getOrElse(pretty, () => body)
	return {
		body,
		isJson,
		formatted,
		// Pretty JSON is the friendlier copy, but only when it is the original bytes reformatted.
		copyValue: isJson && body === (log.body ?? "") ? formatted : (log.body ?? ""),
		isLong: formatted.length > BODY_LINE_THRESHOLD || formatted.includes("\n"),
	}
}

const BODY_LINE_THRESHOLD = 280

/** The trace page, with the log's span pre-selected. */
export const traceHrefOf = (log: LocalLog): Option.Option<string> =>
	log.traceId
		? Option.some(
				hrefFor(`/traces/${encodeURIComponent(log.traceId)}`, new URLSearchParams(log.spanId ? { spanId: log.spanId } : {})),
			)
		: Option.none()

/** `buildLogJsonPayload`: the full log as pretty JSON. */
export const buildLogJsonPayload = (log: LocalLog): string =>
	JSON.stringify(
		{
			timestamp: log.timestamp,
			severityText: log.severityText,
			severityNumber: log.severityNumber,
			serviceName: log.serviceName,
			body: log.body,
			traceId: log.traceId || undefined,
			spanId: log.spanId || undefined,
			logAttributes: log.logAttributes,
			resourceAttributes: log.resourceAttributes,
		},
		null,
		2,
	)

/** `CopyableValue`: inline text that copies itself, tinted by the copy's outcome. */
export const copyableValue = (
	h: HtmlBuilder<Message>,
	copies: Copies,
	options: Readonly<{ id: string; value: string; label?: string }>,
	children: ReadonlyArray<Html | string>,
): Html => {
	const { status } = copyOf(copies, options.id)
	return h.button(
		[
			h.Type("button"),
			h.AriaLabel(`Copy ${options.label ?? "value"}`),
			h.Class(
				cn(
					"-mx-0.5 cursor-pointer rounded px-0.5 text-left transition-colors",
					status === "idle" && "hover:bg-muted/50",
					status === "copied" && "bg-severity-info/20",
					status === "error" && "bg-severity-error/20",
				),
			),
			h.OnClick(Message.GotCopyMessage({ id: options.id, message: CopyButton.Message.ClickedCopy({ text: options.value }) }), {
				propagation: "Stop",
			}),
			h.Title("Click to copy"),
		],
		children,
	)
}
