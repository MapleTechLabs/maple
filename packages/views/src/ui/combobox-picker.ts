import { cn } from "@maple/ui/lib/utils"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "./button"
import { Message, type Model, queryOf } from "./combobox"
import { chipsInput, inputAttributes, listPopup } from "./combobox-view"
import { icon } from "./icon"
import { isMounted } from "./overlay/transition"

/**
 * `ComboboxPicker`: a button showing the current pick that opens a searchable list, the search
 * input on top (a `<ComboboxTrigger>` with `<ComboboxContent>`). The caller matches `items` to the
 * search itself (`queryOf`), so a list can drill into groups or offer a typed value.
 */
export type ComboboxPickerInputs = Readonly<{
	/** The list for the current search, in order. */
	items: ReadonlyArray<string>
	ariaLabel: string
	searchPlaceholder: string
	emptyText: string
	/** The trigger's label: the pick, or a prompt drawn muted with `isPlaceholder`. */
	trigger: ReadonlyArray<Html | string>
	isPlaceholder?: boolean
	renderItem?: (h: HtmlBuilder<Message>, value: string) => ReadonlyArray<Html | string>
	itemClassName?: (value: string) => string | undefined
	triggerClassName?: string
	/** Places the trigger and, while open, the list portal. */
	toView: (parts: ReadonlyArray<Html>) => Html
}>

export const triggerIdOf = (id: string): string => `${id}-trigger`

export const comboboxPicker = Submodel.defineView<Model, Message, ComboboxPickerInputs>(
	(model, inputs, h) => {
		const triggerId = triggerIdOf(model.id)
		const isShown = isMounted(model.isOpen, model.animation)
		const trigger = button(
			h,
			{
				variant: "outline",
				size: "sm",
				className: cn("min-w-0 max-w-full justify-between font-normal", inputs.triggerClassName),
				slot: "combobox-trigger",
				attributes: [
					h.Id(triggerId),
					h.AriaLabel(inputs.ariaLabel),
					h.AriaExpanded(model.isOpen),
					h.AriaHasPopup("dialog"),
					h.Role("combobox"),
					...(isShown ? [h.AriaControls(`${model.id}-popup`)] : []),
					...(model.isOpen ? [h.DataAttribute("popup-open", "")] : []),
					h.OnClick(Message.ClickedTriggerOf({ items: inputs.items })),
				],
			},
			[
				h.span(
					[
						h.Class(
							cn("min-w-0 truncate", inputs.isPlaceholder === true && "text-muted-foreground"),
						),
					],
					inputs.trigger,
				),
				icon(h, "ChevronDownIcon", { size: 12, className: "shrink-0 text-muted-foreground" }),
			],
		)
		const header = h.div(
			[h.Class("flex items-center gap-2 border-b border-border-subtle px-3")],
			[
				icon(h, "MagnifierIcon", { className: "size-3.5 shrink-0 text-foreground-subtle" }),
				chipsInput(h, {
					size: "sm",
					className: "h-9 w-full ps-0 text-xs",
					attributes: [
						h.Attribute("autofocus", ""),
						...inputAttributes(
							h,
							{ ...model, inputValue: queryOf(model) },
							{
								slot: "combobox-chips-input",
								ariaLabel: `Search ${inputs.ariaLabel}`,
								placeholder: inputs.searchPlaceholder,
								items: inputs.items,
								isUnfiltered: true,
							},
							(message) => message,
						),
					],
				}),
			],
		)
		return inputs.toView([
			trigger,
			...(isShown
				? [
						listPopup(h, model, {
							slot: "combobox",
							items: inputs.items,
							isPrefiltered: true,
							emptyText: inputs.emptyText,
							anchorSelector: `#${triggerId}`,
							className: "w-72 max-w-[calc(100vw-2rem)] overflow-hidden",
							positionerClassName: "z-60",
							listClassName: "max-h-72 overflow-y-auto p-1",
							itemClassName: (value) =>
								cn(
									"min-h-7 grid-cols-[1rem_minmax(0,1fr)] text-xs",
									inputs.itemClassName?.(value),
								),
							renderItem: (value) => inputs.renderItem?.(h, value) ?? [value],
							trigger: { returnFocusId: triggerId, header },
						}),
					]
				: []),
		])
	},
)
