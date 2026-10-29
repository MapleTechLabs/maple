import { SEVERITY_COLORS } from "@maple/ui/lib/severity"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Html } from "foldkit/html"
import { hrefFor } from "../../../route"
import { type Copies, CopyMessage, copyOf } from "../copies"
import type { LogSheetViewBuilder } from "./composition"
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

/** The trace page, with the log's span pre-selected. */
export const traceHrefOf = (log: LocalLog): Option.Option<string> =>
	log.traceId
		? Option.some(
				hrefFor(
					`/traces/${encodeURIComponent(log.traceId)}`,
					new URLSearchParams(log.spanId ? { spanId: log.spanId } : {}),
				),
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

/** A click on the copy control `id`, copying `text`. */
export const copyClick = (id: string, text: string): Message =>
	Message.ReceivedCopyMessage({ message: CopyMessage.ClickedCopy({ id, text }) })

/** Lifts a copy fact into the sheet's Message, for `copiesButton`. */
export const toCopyMessage = (message: CopyMessage): Message => Message.ReceivedCopyMessage({ message })

/** `CopyableValue`: inline text that copies itself, tinted by the copy's outcome. */
export const copyableValue = (
	h: LogSheetViewBuilder,
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
			h.OnClick(copyClick(options.id, options.value), {
				propagation: "Stop",
			}),
			h.Title("Click to copy"),
		],
		children,
	)
}
