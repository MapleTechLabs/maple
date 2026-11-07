import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { button } from "@maple/views/ui/button"
import {
	empty,
	emptyContent,
	emptyDescription,
	emptyHeader,
	emptyMedia,
	emptyTitle,
} from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { skeleton } from "@maple/views/ui/skeleton"
import { metricStripLoading } from "../agent-sessions/tools-kit/metric-strip"
import { SEMCONV_MCP_URL } from "./view-kit"
import { Array as Arr } from "effect"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { textLink } from "@maple/views/ui/text-link"

// The MCP pages' empty, loading, error and quiet-window states.

const SPAN_EXAMPLE: ReadonlyArray<readonly [string, string, string]> = [
	["mcp.method.name", "tools/call", ""],
	["gen_ai.tool.name", "run_sql", ""],
	["error.type", "tool_error", "# isError result"],
	["user.id", "user_42", "# users, sessions"],
	["mcp.session.id", "7f3c…", "# older servers"],
]

/** The span Maple reads, drawn as the on-ramp's example. */
const spanExample = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[
			h.Class(
				"w-full max-w-lg rounded-md border border-border bg-card px-4 py-3 text-left font-mono text-2xs leading-5",
			),
		],
		[
			h.div(
				[],
				[
					typography(h, { tone: "foreground" }, ["tools/call run_sql"]),
					h.span([h.Class("ml-3 text-foreground-subtle")], ["kind SERVER"]),
				],
			),
			...Arr.map(SPAN_EXAMPLE, ([key, value, comment]) =>
				hstack(h, { gap: "3", align: "stretch", className: "pl-3" }, [
					h.span([h.Class("w-28 shrink-0 text-muted-foreground")], [key]),
					h.span([h.Class("w-20 shrink-0 text-foreground")], [value]),
					typography(h, { tone: "subtle" }, [comment]),
				]),
			),
		],
	)

/** `/mcp` with no MCP spans: the integration on-ramp, never demo data. */
export const noServersState = <M>(h: HtmlBuilder<M>, options: Readonly<{ onInstrument: M }>): Html =>
	h.div(
		[h.Class("border-t border-border px-6 py-14")],
		[
			empty(h, [
				emptyHeader(h, [
					emptyMedia(h, { variant: "icon" }, [icon(h, "PlugIcon")]),
					emptyTitle(h, ["No MCP servers yet"]),
					emptyDescription(h, [
						"See which tools agents call on your MCP server, which clients call them and why calls fail. Maple reads the OpenTelemetry MCP conventions, so any server that emits them shows up here.",
					]),
				]),
				emptyContent(h, [
					spanExample(h),
					hstack(
						h,
						{ align: "center", justify: "center", wrap: true, className: "gap-x-4 gap-y-2" },
						[
							button(h, { size: "sm", attributes: [h.OnClick(options.onInstrument)] }, [
								icon(h, "PlugIcon", { size: 14 }),
								"Instrument an MCP server",
							]),
							textLink(
								h,
								{
									href: SEMCONV_MCP_URL,
									tone: "muted",
									className: "gap-1.5 text-sm underline-offset-4",
									attributes: [h.Target("_blank"), h.Rel("noopener noreferrer")],
								},
								["MCP conventions", icon(h, "ExternalLinkIcon", { size: 12 })],
							),
						],
					),
				]),
			]),
		],
	)

/** The server page while its first read is out. */
export const serverLoading = <M>(h: HtmlBuilder<M>): Html =>
	vstack(h, { gap: "5", className: "pt-3" }, [
		skeleton(h, "mx-6 h-8 max-w-2xl"),
		metricStripLoading(h),
		skeleton(h, "mx-6 h-56"),
		skeleton(h, "mx-6 h-80"),
	])

/** The sessions list while its first read is out: the toolbar and the table's rows. */
export const sessionsLoading = <M>(h: HtmlBuilder<M>): Html =>
	vstack(h, { gap: "3", className: "px-6 pt-3" }, [
		skeleton(h, "h-8 max-w-2xl"),
		skeleton(h, "mt-6 h-4 w-32"),
		...Array.from({ length: 6 }, () => skeleton(h, "h-9")),
	])

/** The server page when its read failed. */
export const serverError = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ failure: LoadFailure; onRetry: M; title?: string }>,
): Html =>
	h.div(
		[h.Class("p-4")],
		[
			errorState(h, {
				failure: options.failure,
				title: options.title ?? "Couldn't load MCP server analytics",
				onRetry: options.onRetry,
			}),
		],
	)

type Widen<M> = Readonly<{ onWiden: M; label: string }>

/** The quiet states' way out: a longer window, absent at the widest the page offers. */
const widenAction = <M>(h: HtmlBuilder<M>, widen: Widen<M> | undefined): ReadonlyArray<Html> =>
	widen === undefined
		? []
		: [
				emptyContent(h, [
					button(h, { variant: "outline", size: "sm", attributes: [h.OnClick(widen.onWiden)] }, [
						widen.label,
					]),
				]),
			]

/** `executor`, `executor and Claude`, `executor, Claude and 2 more`. */
export const connectedText = (names: ReadonlyArray<string>): string =>
	names.length <= 2
		? Arr.join(names, " and ")
		: `${Arr.join(names.slice(0, 2), ", ")} and ${names.length - 2} more`

/** The server answered nothing in the window; `lastCall` when the page knows when it last did. */
export const quietWindow = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		service: string
		window: string
		lastCall?: string
		/** The server sent other MCP spans (initialize, tools/list) in the window, just no tool call. */
		hasOtherSpans?: boolean
		/** Clients that connected in the window without calling a tool, most connects first. */
		connected?: ReadonlyArray<string>
		/** Absent at the widest window the page offers. */
		widen?: Widen<M>
	}>,
): Html =>
	h.div(
		[h.Class("border-t border-border px-6 py-14")],
		[
			empty(h, [
				emptyHeader(h, [
					emptyMedia(h, { variant: "icon" }, [icon(h, "ClockIcon")]),
					emptyTitle(h, [`No tool calls in the ${options.window}`]),
					emptyDescription(h, [
						options.lastCall !== undefined
							? `${options.service} last answered a tool call ${options.lastCall}.`
							: options.connected !== undefined && options.connected.length > 0
								? `${connectedText(options.connected)} connected to ${options.service} but called no tool in this window.`
								: options.hasOtherSpans === true
									? `${options.service} answered MCP requests but no tool call in this window.`
									: `No MCP server span from ${options.service} in this window.`,
					]),
				]),
				...widenAction(h, options.widen),
			]),
		],
	)

/** A server whose spans carry no `mcp.session.id`: what to send so calls group into sessions. */
export const noSessionsState = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ service: string; onInstrument: M }>,
): Html =>
	h.div(
		[h.Class("border-t border-border px-6 py-14")],
		[
			empty(h, [
				emptyHeader(h, [
					emptyMedia(h, { variant: "icon" }, [icon(h, "LayersIcon")]),
					emptyTitle(h, ["No sessions yet"]),
					emptyDescription(h, [
						`${options.service} answers tool calls, but none names its user. Set user.id on every server span, from the key or token that authenticates the request, and each user's calls from one client group into sessions. A server on an older, stateful transport can record its Mcp-Session-Id as mcp.session.id instead.`,
					]),
				]),
				emptyContent(h, [
					spanExample(h),
					button(
						h,
						{ variant: "outline", size: "sm", attributes: [h.OnClick(options.onInstrument)] },
						["MCP conventions", icon(h, "ExternalLinkIcon", { size: 12 })],
					),
				]),
			]),
		],
	)

/** A session id with no request from the server in the window. */
export const sessionNotFound = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ service: string; window: string; widen?: Widen<M> }>,
): Html =>
	h.div(
		[h.Class("border-t border-border px-6 py-14")],
		[
			empty(h, [
				emptyHeader(h, [
					emptyMedia(h, { variant: "icon" }, [icon(h, "ClockIcon")]),
					emptyTitle(h, [`No requests in the ${options.window}`]),
					emptyDescription(h, [
						`No request in this session reached ${options.service} in this window. It may have run earlier.`,
					]),
				]),
				...widenAction(h, options.widen),
			]),
		],
	)
