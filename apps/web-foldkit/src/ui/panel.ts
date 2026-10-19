import { cn } from "@maple/ui/lib/utils"
import {
	panelBodyStyles,
	panelHeaderActionStyles,
	panelHeaderDividedStyles,
	panelHeaderStyles,
	panelHeaderTitleRowStyles,
	panelHeaderUndividedStyles,
	panelPaddingStyles,
	panelStyles,
	panelTitleStyles,
	panelToneStyles,
} from "@maple/ui/styles/ui/panel"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

// Port of packages/ui/src/components/ui/panel.tsx: the flat bordered section frame.

type Children = ReadonlyArray<Html | string>
export type PanelTone = keyof typeof panelToneStyles

export const panel = <M>(
	h: HtmlBuilder<M>,
	options: {
		readonly padded?: boolean | "sm"
		readonly tone?: PanelTone
		readonly className?: string
		/** Props spread after the panel's own (a `ref` target marker, an id). */
		readonly attributes?: ReadonlyArray<Attribute<M>>
	},
	children: Children,
): Html =>
	h.section(
		[
			h.Class(
				cn(
					panelStyles,
					panelToneStyles[options.tone ?? "default"],
					options.padded === "sm"
						? panelPaddingStyles.sm
						: options.padded === true
							? panelPaddingStyles.md
							: null,
					options.className,
				),
			),
			h.DataAttribute("slot", "panel"),
			...(options.attributes ?? []),
		],
		children,
	)

export const panelTitle = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.h3([h.Class(cn(panelTitleStyles, className)), h.DataAttribute("slot", "panel-title")], children)

export interface PanelHeaderOptions {
	readonly title?: Html | string
	/** Marker beside the title saying what the panel is filtered to. */
	readonly scope?: Html
	readonly action?: Html
	/** Bottom border under the strip; chart panels turn it off. */
	readonly divided?: boolean
	readonly className?: string
	/** Replaces the title row. */
	readonly children?: Children
}

const titleRow = <M>(h: HtmlBuilder<M>, options: PanelHeaderOptions): Html =>
	h.div(
		[h.Class(panelHeaderTitleRowStyles)],
		[
			panelTitle(h, options.title === undefined ? [] : [options.title]),
			...(options.scope ? [options.scope] : []),
		],
	)

const actionSlot = <M>(h: HtmlBuilder<M>, action: Html): Html =>
	h.div([h.Class(panelHeaderActionStyles)], [action])

export const panelHeader = <M>(h: HtmlBuilder<M>, options: PanelHeaderOptions): Html =>
	h.header(
		[
			h.Class(
				cn(
					panelHeaderStyles,
					(options.divided ?? true) ? panelHeaderDividedStyles : panelHeaderUndividedStyles,
					options.className,
				),
			),
			h.DataAttribute("slot", "panel-header"),
		],
		[
			...(options.children ?? [titleRow(h, options)]),
			...(options.action ? [actionSlot(h, options.action)] : []),
		],
	)

export const panelBody = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.div([h.Class(cn(panelBodyStyles, className)), h.DataAttribute("slot", "panel-body")], children)
