import { cn } from "@maple/ui/lib/utils"
import {
	traceDescriptionStyles,
	traceIconStyles,
	traceLineStyles,
	traceStyles,
	traceTitleStyles,
} from "@maple/ui/styles/ui/trace"
import type { Html, HtmlBuilder } from "foldkit/html"

// Port of packages/ui/src/components/ui/trace.tsx: a list of agent tool-call lines.
// The collapsible parts are not ported (no caller yet).

export type TraceStatus = "running" | "error" | "pending"
type Children = ReadonlyArray<Html | string>

export const trace = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.div([h.DataAttribute("slot", "trace"), h.Class(cn(traceStyles, className))], children)

export const traceLine = <M>(
	h: HtmlBuilder<M>,
	options: { readonly status?: TraceStatus; readonly className?: string },
	children: Children,
): Html =>
	h.span(
		[
			h.DataAttribute("slot", "trace-line"),
			...(options.status === undefined ? [] : [h.DataAttribute("status", options.status)]),
			h.Class(cn(traceLineStyles, options.className)),
		],
		children,
	)

export const traceIcon = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.span(
		[h.DataAttribute("slot", "trace-icon"), h.AriaHidden(true), h.Class(cn(traceIconStyles, className))],
		children,
	)

export const traceTitle = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.span([h.DataAttribute("slot", "trace-title"), h.Class(cn(traceTitleStyles, className))], children)

export const traceDescription = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.span(
		[h.DataAttribute("slot", "trace-description"), h.Class(cn(traceDescriptionStyles, className))],
		children,
	)
