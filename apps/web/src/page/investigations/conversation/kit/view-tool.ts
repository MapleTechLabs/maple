import { Effect, Option } from "effect"
import { Mount } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../../../ui/icon"
import { spinner } from "../../../../ui/spinner"
import {
	trace,
	traceCollapsible,
	traceDescription,
	traceIcon,
	traceLine,
	traceTitle,
} from "../../../../ui/trace"
import { dotLoader } from "./dot-loader"
import { toolActivity, toolIcon, toolLabel } from "./tool-metadata"
import {
	extractOutputText,
	extractStructuredData,
	inputRecord,
	type StructuredPayload,
	toolSummary,
} from "./tool-output"
import { deriveToolStatus, type ToolStatus } from "./transcript-rows"
import type { ToolPart } from "./ui-message"

// `Tool`, `ToolRow` and `ToolGroup`: a tool call's row and a run of them grouped.
/** What a tool row needs from its host: whether a panel is open, and the Message that toggles it. */
export type PanelHost<M> = Readonly<{
	isOpen: (id: string) => boolean
	onToggle: (id: string) => M
	/** The structured renderer for a `__maple_ui` payload (lab and page draw the same one). */
	structured?: (payload: StructuredPayload) => Html
	/** `MountRunningClock` lifted to the host's Message; without it no clock is drawn. */
	clockMount?: Parameters<HtmlBuilder<M>["OnMount"]>[0]
}>

/** `useElapsedSeconds` + `formatElapsed`: `4s`, `1m 12s`; nothing under two seconds. */
export const formatElapsed = (seconds: number): string =>
	seconds < 2 ? "" : seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`

export const CompletedMountClock = defineMessageUnion({ CompletedMountClock: {} }).CompletedMountClock

/** `RunningClock`: its own one-second timer from when it appeared; hidden while it has nothing to say. */
export const MountRunningClock = Mount.define("MountChatRunningClock", {
	messages: [CompletedMountClock],
	execute: ({ element }) =>
		Effect.as(
			Effect.acquireRelease(
				Effect.sync(() => {
					const startedAt = Date.now()
					const id = setInterval(() => {
						const text = formatElapsed(Math.floor((Date.now() - startedAt) / 1000))
						element.textContent = text
						element.toggleAttribute("hidden", text === "")
					}, 1000)
					return () => clearInterval(id)
				}),
				(release) => Effect.sync(release),
			),
			CompletedMountClock(),
		),
})

/** The clock's span, drawn hidden; its Mount fills and shows it. */
export const runningClock = <M>(h: HtmlBuilder<M>, mount: PanelHost<M>["clockMount"]): ReadonlyArray<Html> =>
	mount === undefined
		? []
		: [
				h.span(
					[
						h.Class("shrink-0 tabular-nums text-2xs text-foreground-subtle"),
						h.Attribute("hidden", ""),
						h.OnMount(mount),
					],
					[],
				),
			]

const statusGlyph = <M>(h: HtmlBuilder<M>, status: ToolStatus, live: boolean, toolName: string): Html => {
	if (status === "running")
		return live ? dotLoader(h) : spinner(h, "size-3.5 text-muted-foreground motion-reduce:animate-none")
	if (status === "error") return icon(h, "CircleXmarkIcon", { className: "size-3.5 text-severity-error" })
	if (status === "stopped")
		return icon(h, "CircleWarningIcon", { className: "size-3.5 text-muted-foreground" })
	return icon(h, toolIcon(toolName), { className: "size-3.5" })
}

const argumentRows = <M>(h: HtmlBuilder<M>, record: Readonly<Record<string, unknown>>): ReadonlyArray<Html> =>
	Object.entries(record)
		.filter(([, value]) => value !== null && value !== undefined)
		.map(([key, value]) =>
			h.div(
				[h.Class("flex gap-2")],
				[
					h.span([h.Class("shrink-0")], [key, ":"]),
					h.span(
						[h.Class("min-w-0 font-mono break-all whitespace-pre-wrap text-foreground")],
						[typeof value === "string" ? value : JSON.stringify(value)],
					),
				],
			),
		)

const panelContent = <M>(h: HtmlBuilder<M>, part: ToolPart, host: PanelHost<M>): ReadonlyArray<Html> => {
	const record = Option.filter(inputRecord(part.input), (input) => Object.keys(input).length > 0)
	const structured = extractStructuredData(part.output)
	const outputText = extractOutputText(part.output)
	return [
		...Option.match(record, {
			onNone: () => [],
			onSome: (input) => [
				h.div(
					[],
					[
						h.p([h.Class("mb-1 font-medium")], ["Arguments"]),
						h.div([h.Class("max-h-60 space-y-0.5 overflow-auto")], argumentRows(h, input)),
					],
				),
			],
		}),
		...(part.errorText === undefined
			? []
			: [
					h.div(
						[],
						[
							h.p([h.Class("mb-1 font-medium text-severity-error")], ["Error"]),
							h.pre(
								[
									h.Class(
										"max-h-40 overflow-auto whitespace-pre-wrap text-severity-error/80",
									),
								],
								[part.errorText],
							),
						],
					),
				]),
		...Option.match(structured, {
			onSome: (data) => [
				h.div(
					[h.Class("text-foreground")],
					host.structured === undefined ? [] : [host.structured(data)],
				),
			],
			onNone: () =>
				outputText === null
					? []
					: [
							h.div(
								[],
								[
									h.p([h.Class("mb-1 font-medium")], ["Result"]),
									h.pre(
										[h.Class("max-h-80 overflow-auto whitespace-pre-wrap")],
										[outputText],
									),
								],
							),
						],
		}),
	]
}

const hasPanel = (part: ToolPart): boolean =>
	Option.exists(inputRecord(part.input), (input) => Object.keys(input).length > 0) ||
	Option.isSome(extractStructuredData(part.output)) ||
	extractOutputText(part.output) !== null ||
	part.errorText !== undefined

/** One tool call as a quiet line that opens to its arguments and result. */
export const toolRow = <M>(h: HtmlBuilder<M>, part: ToolPart, host: PanelHost<M>, live = false): Html => {
	const status = deriveToolStatus(part.state)
	const label = status === "running" ? toolActivity(part.toolName) : toolLabel(part.toolName)
	const summary = toolSummary(part.input)
	// A failure reds the glyph only; the label stays legible in the line's own colour.
	const line = traceLine(h, status === "running" ? { status } : {}, [
		traceIcon(h, [statusGlyph(h, status, live, part.toolName)], live ? "size-5" : undefined),
		// The glyph is hidden from assistive tech, so the state is said in words.
		...(status === "stopped" ? [h.span([h.Class("sr-only")], ["Stopped"])] : []),
		...(status === "error" ? [h.span([h.Class("sr-only")], ["Failed"])] : []),
		h.span(
			[
				h.Class("min-w-0 truncate motion-reduce:shimmer-none font-medium"),
				h.DataAttribute("slot", "trace-title"),
				h.Title(label),
			],
			[label],
		),
		...(summary === undefined
			? []
			: [
					traceDescription(
						h,
						[summary],
						"min-w-0 shrink truncate font-mono text-2xs text-foreground-subtle",
					),
				]),
		...(status === "running" && live ? runningClock(h, host.clockMount) : []),
	])
	if (!hasPanel(part)) return line
	const id = `tool:${part.toolCallId}`
	return traceCollapsible(h, {
		isOpen: host.isOpen(id),
		panelId: `${id}:panel`,
		onToggle: host.onToggle(id),
		line,
		contentClassName: "space-y-2 text-xs",
		content: () => panelContent(h, part, host),
	})
}

/** A tool call standing on its own, in a `Trace` of one. */
export const toolStandalone = <M>(h: HtmlBuilder<M>, part: ToolPart, host: PanelHost<M>): Html =>
	trace(h, [toolRow(h, part, host, deriveToolStatus(part.state) === "running")])

type Tally = { readonly label: string; readonly icon: ReturnType<typeof toolIcon>; readonly count: number }

const tally = (names: ReadonlyArray<string>): ReadonlyArray<Tally> =>
	names.reduce<ReadonlyArray<Tally>>((acc, name) => {
		const label = toolLabel(name)
		return acc.some((entry) => entry.label === label)
			? acc.map((entry) => (entry.label === label ? { ...entry, count: entry.count + 1 } : entry))
			: [...acc, { label, icon: toolIcon(name), count: 1 }]
	}, [])

const NAMED_TOOLS = 3

/** A run of tool calls behind one line, collapsed by default; the header names the work. */
export const toolGroup = <M>(
	h: HtmlBuilder<M>,
	parts: ReadonlyArray<ToolPart>,
	keyHint: string,
	host: PanelHost<M>,
): Html => {
	const running = parts.filter((part) => deriveToolStatus(part.state) === "running")
	const errorCount = parts.filter((part) => deriveToolStatus(part.state) === "error").length
	const current = running[running.length - 1]
	const tools = tally(parts.map((part) => part.toolName))
	const named = tools.slice(0, NAMED_TOOLS)
	const hidden = tools.length - named.length
	const line =
		running.length > 0
			? traceLine(h, { status: "running" }, [
					traceIcon(h, [dotLoader(h)], "size-5"),
					traceTitle(h, [toolActivity(current?.toolName ?? "")], "font-medium"),
					traceDescription(h, [`${parts.length - running.length}`, "/", `${parts.length}`]),
					...runningClock(h, host.clockMount),
				])
			: traceLine(h, {}, [
					...named.map((tool) => traceIcon(h, [icon(h, tool.icon, { className: "size-3.5" })])),
					traceTitle(
						h,
						[
							...named.map((tool, index) =>
								h.span(
									[],
									[
										...(index > 0
											? [h.span([h.Class("text-foreground-faint")], [" · "])]
											: []),
										tool.label,
										...(tool.count > 1
											? [
													h.span(
														[
															h.Class(
																"font-normal tabular-nums text-foreground-subtle",
															),
														],
														[" ", `×${tool.count}`],
													),
												]
											: []),
									],
								),
							),
							...(hidden > 0
								? [
										h.span(
											[h.Class("font-normal text-foreground-subtle")],
											[` +${hidden} more`],
										),
									]
								: []),
						],
						"font-medium",
					),
					...(errorCount > 0
						? [traceDescription(h, [`${errorCount}`, " failed"], "text-severity-error")]
						: []),
				])
	const id = `group:${parts[0]?.toolCallId ?? keyHint}`
	return trace(
		h,
		[
			traceCollapsible(h, {
				isOpen: host.isOpen(id),
				panelId: `${id}:panel`,
				onToggle: host.onToggle(id),
				line,
				content: () => [
					trace(
						h,
						parts.map((part) => toolRow(h, part, host)),
						"max-h-[55vh] overflow-y-auto",
					),
				],
			}),
		],
		undefined,
		"tool-group",
	)
}

/** A buffer of tool calls: a bare line for one, a group for several. */
export const toolNodes = <M>(
	h: HtmlBuilder<M>,
	parts: ReadonlyArray<ToolPart>,
	keyHint: string,
	host: PanelHost<M>,
): ReadonlyArray<Html> => {
	const [only] = parts
	if (only === undefined) return []
	return parts.length === 1 ? [toolStandalone(h, only, host)] : [toolGroup(h, parts, keyHint, host)]
}
