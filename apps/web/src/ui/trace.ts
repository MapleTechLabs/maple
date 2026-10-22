import { cn } from "@maple/ui/lib/utils"
import { collapsiblePanelStyles } from "@maple/ui/styles/ui/collapsible"
import {
	traceCollapsibleContentStyles,
	traceCollapsibleStyles,
	traceCollapsibleTriggerIconStyles,
	traceCollapsibleTriggerStyles,
	traceDescriptionStyles,
	traceIconStyles,
	traceLineStyles,
	traceStyles,
	traceTitleStyles,
} from "@maple/ui/styles/ui/trace"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "./icon"

// Port of packages/ui/src/components/ui/trace.tsx: a list of agent tool-call lines.

export type TraceStatus = "running" | "error" | "pending"
type Children = ReadonlyArray<Html | string>

/** `slot` overrides `data-slot` (`<Trace data-slot="tool-group">`). */
export const trace = <M>(h: HtmlBuilder<M>, children: Children, className?: string, slot = "trace"): Html =>
	h.div([h.DataAttribute("slot", slot), h.Class(cn(traceStyles, className))], children)

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

/** `TraceCollapsible` (Base UI Collapsible): the trigger line and, while open, its detail panel. */
export const traceCollapsible = <M>(
	h: HtmlBuilder<M>,
	options: {
		readonly isOpen: boolean
		/** The panel's id (`aria-controls`). */
		readonly panelId: string
		readonly onToggle: M
		readonly line: Html
		/** The panel body, rendered only while open (Base UI unmounts a closed panel). */
		readonly content: () => ReadonlyArray<Html | string>
		readonly contentClassName?: string
		readonly className?: string
	},
): Html =>
	h.div(
		[
			h.Class(cn(traceCollapsibleStyles, options.className)),
			h.DataAttribute(options.isOpen ? "open" : "closed", ""),
			h.DataAttribute("slot", "trace-collapsible"),
		],
		[
			h.button(
				[
					...(options.isOpen ? [h.AriaControls(options.panelId)] : []),
					h.AriaDisabled(false),
					h.AriaExpanded(options.isOpen),
					h.Class(traceCollapsibleTriggerStyles),
					...(options.isOpen ? [h.DataAttribute("panel-open", "")] : []),
					h.DataAttribute("slot", "trace-collapsible-trigger"),
					h.Tabindex(0),
					h.Type("button"),
					h.OnClick(options.onToggle),
				],
				[
					options.line,
					traceIcon(h, [icon(h, "ChevronRightIcon")], traceCollapsibleTriggerIconStyles),
				],
			),
			...(options.isOpen
				? [
						h.div(
							[
								h.Class(collapsiblePanelStyles),
								h.DataAttribute("open", ""),
								h.DataAttribute("slot", "trace-collapsible-content"),
								h.Id(options.panelId),
								h.Style({
									"--collapsible-panel-height": "auto",
									"--collapsible-panel-width": "auto",
								}),
							],
							[
								h.div(
									[h.Class(cn(traceCollapsibleContentStyles, options.contentClassName))],
									options.content(),
								),
							],
						),
					]
				: []),
		],
	)

export const traceDescription = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.span(
		[h.DataAttribute("slot", "trace-description"), h.Class(cn(traceDescriptionStyles, className))],
		children,
	)
