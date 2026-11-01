import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "../../data/load-failure"
import { button } from "../../ui/button"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../ui/empty"
import { errorState } from "../../ui/error-state"
import { icon } from "../../ui/icon"
import { skeleton } from "../../ui/skeleton"
import { metricStripLoading } from "../agent-sessions/tools-kit/metric-strip"
import { SEMCONV_MCP_URL } from "./view-kit"

// The MCP pages' empty, loading, error and quiet-window states.

const SPAN_EXAMPLE: ReadonlyArray<readonly [string, string, string]> = [
	["mcp.method.name", "tools/call", ""],
	["gen_ai.tool.name", "run_sql", ""],
	["error.type", "tool_error", "# the result had isError"],
	["mcp.session.id", "7f3c…", "# unlocks sessions"],
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
					h.span([h.Class("text-foreground")], ["tools/call run_sql"]),
					h.span([h.Class("ml-3 text-foreground-subtle")], ["kind SERVER"]),
				],
			),
			...SPAN_EXAMPLE.map(([key, value, comment]) =>
				h.div(
					[h.Class("flex gap-3 pl-3")],
					[
						h.span([h.Class("w-32 shrink-0 text-muted-foreground")], [key]),
						h.span([h.Class("w-20 shrink-0 text-foreground")], [value]),
						h.span([h.Class("text-foreground-subtle")], [comment]),
					],
				),
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
					h.div(
						[h.Class("flex flex-wrap items-center justify-center gap-x-4 gap-y-2")],
						[
							button(h, { size: "sm", attributes: [h.OnClick(options.onInstrument)] }, [
								icon(h, "PlugIcon", { size: 14 }),
								"Instrument an MCP server",
							]),
							h.a(
								[
									h.Href(SEMCONV_MCP_URL),
									h.Target("_blank"),
									h.Rel("noopener noreferrer"),
									h.Class(
										"inline-flex items-center gap-1.5 text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline active:text-foreground active:underline",
									),
								],
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
	h.div(
		[h.Class("flex flex-col gap-5 pt-3")],
		[
			skeleton(h, "mx-6 h-8 max-w-2xl"),
			metricStripLoading(h),
			skeleton(h, "mx-6 h-56"),
			skeleton(h, "mx-6 h-80"),
		],
	)

/** The server page when its read failed. */
export const serverError = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ failure: LoadFailure; onRetry: M }>,
): Html =>
	h.div(
		[h.Class("p-4")],
		[
			errorState(h, {
				failure: options.failure,
				title: "Couldn't load MCP server analytics",
				onRetry: options.onRetry,
			}),
		],
	)

/** The server answered nothing in the window; `lastCall` when the page knows when it last did. */
export const quietWindow = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		service: string
		window: string
		lastCall?: string
		/** The server sent other MCP spans (initialize, tools/list) in the window, just no tool call. */
		hasOtherSpans?: boolean
		/** Absent at the widest window the page offers. */
		widen?: Readonly<{ onWiden: M; label: string }>
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
							: options.hasOtherSpans === true
								? `${options.service} answered MCP requests but no tool call in this window.`
								: `No MCP server span from ${options.service} in this window.`,
					]),
				]),
				...(options.widen === undefined
					? []
					: [
							emptyContent(h, [
								button(
									h,
									{
										variant: "outline",
										size: "sm",
										attributes: [h.OnClick(options.widen.onWiden)],
									},
									[options.widen.label],
								),
							]),
						]),
			]),
		],
	)
