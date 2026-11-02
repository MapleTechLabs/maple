import { cn } from "@maple/ui/lib/utils"
import { collapsiblePanelStyles } from "@maple/ui/styles/ui/collapsible"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

/**
 * `Collapsible` whose open state lives in the owner's Model: the trigger button and, while open,
 * its panel (closed, Base UI renders no panel). `triggerClassName` owns the trigger's look.
 */
export type CollapsibleOptions<M> = Readonly<{
	isOpen: boolean
	onToggle: M
	panelId: string
	trigger: ReadonlyArray<Html | string>
	triggerClassName?: string
	panelClassName?: string
	/** On the root, e.g. a Key. */
	attributes?: ReadonlyArray<Attribute<M>>
}>

export const collapsible = <M>(
	h: HtmlBuilder<M>,
	options: CollapsibleOptions<M>,
	panel: ReadonlyArray<Html>,
): Html => {
	const { isOpen, panelId } = options
	return h.div(
		[
			...(options.attributes ?? []),
			h.DataAttribute(isOpen ? "open" : "closed", ""),
			h.DataAttribute("slot", "collapsible"),
		],
		[
			h.button(
				[
					...(isOpen ? [h.AriaControls(panelId)] : []),
					h.AriaDisabled(false),
					h.AriaExpanded(isOpen),
					...(options.triggerClassName === undefined ? [] : [h.Class(options.triggerClassName)]),
					...(isOpen ? [h.DataAttribute("panel-open", "")] : []),
					h.DataAttribute("slot", "collapsible-trigger"),
					h.Tabindex(0),
					h.Type("button"),
					h.OnClick(options.onToggle),
				],
				options.trigger,
			),
			...(isOpen
				? [
						h.div(
							[
								h.Class(cn(collapsiblePanelStyles, options.panelClassName)),
								h.DataAttribute("open", ""),
								h.DataAttribute("slot", "collapsible-panel"),
								h.Id(panelId),
								h.Style({
									"--collapsible-panel-height": "auto",
									"--collapsible-panel-width": "auto",
									"animation-name": "none",
								}),
							],
							panel,
						),
					]
				: []),
		],
	)
}

/** The trigger alone, for a header that sets other controls beside it (a copy button); the
 *  caller renders the `data-slot="collapsible"` root and the panel. */
export const collapsibleTrigger = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ isOpen: boolean; onToggle: M; panelId?: string; className?: string }>,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.button(
		[
			...(options.isOpen && options.panelId !== undefined ? [h.AriaControls(options.panelId)] : []),
			h.AriaDisabled(false),
			h.AriaExpanded(options.isOpen),
			...(options.className === undefined ? [] : [h.Class(options.className)]),
			...(options.isOpen ? [h.DataAttribute("panel-open", "")] : []),
			h.DataAttribute("slot", "collapsible-trigger"),
			h.Tabindex(0),
			h.Type("button"),
			h.OnClick(options.onToggle),
		],
		children,
	)
