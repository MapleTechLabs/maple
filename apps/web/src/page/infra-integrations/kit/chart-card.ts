import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { chartEmpty } from "@maple/views/ui/chart-state"
import { panel, panelHeader, panelTitle } from "@maple/views/ui/panel"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack, vstackClass } from "@maple/views/ui/stack"

// `ChartCard` and `ChartCardMessage`.

/** Every infra detail chart plots at this height, so a grid of them never staggers. */
export const CHART_HEIGHT = 200

export type ChartCardOptions = Readonly<{
	/** Omit for a chart that renders its own header. */
	title?: Html | string
	description?: Html | string
	legend?: Html
	scope?: Html
	/** Drops the border, for a chart that is a section of an already divided page. */
	bare?: boolean
	className?: string
}>

const header = <M>(h: HtmlBuilder<M>, options: ChartCardOptions): Html | null => {
	const title = options.title
	if (title === undefined) return null
	return panelHeader(h, {
		title,
		scope: options.scope,
		action: options.legend,
		divided: false,
		className: cn("px-3 pt-2.5", options.bare === true && "px-0 pt-0"),
		children:
			options.description === undefined
				? undefined
				: [
						vstack(h, { gap: "0.5", shrink: true }, [
							hstack(h, { gap: "2", align: "center", wrap: true, shrink: true }, [
								panelTitle(h, [title]),
								...(options.scope === undefined ? [] : [options.scope]),
							]),
							typography(h, { size: "2xs", tone: "subtle", as: "p" }, [options.description]),
						]),
					],
	})
}

export const chartCard = <M>(
	h: HtmlBuilder<M>,
	options: ChartCardOptions,
	children: ReadonlyArray<Html>,
): Html => {
	const head = header(h, options)
	const content = [...(head === null ? [] : [head]), ...children]
	return options.bare === true
		? h.section([h.Class(cn(vstackClass({ shrink: true }), options.className))], content)
		: panel(h, { className: options.className }, content)
}

/** `ChartCardMessage`: a centred message filling the card's plot area. */
export const chartCardMessage = <M>(h: HtmlBuilder<M>, message: string): Html =>
	chartEmpty(h, { height: CHART_HEIGHT }, [message])
