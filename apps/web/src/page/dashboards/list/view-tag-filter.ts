import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import * as Combobox from "../../../ui/combobox"
import { hiddenInput, inputField, listPopup } from "../../../ui/combobox-view"
import { icon } from "../../../ui/icon"
import { isMounted } from "../../../ui/overlay/transition"

// `TagFilterMenu`'s `MultiSelectCombobox` in `mode="trigger"`: the Tags button, and its popup with
// the tag search, the tag list and "Clear tags".

type Inputs = Readonly<{ allTags: ReadonlyArray<string> }>

export const tagFilterView = Submodel.defineView<Combobox.Model, Combobox.Message, Inputs>(
	(model, inputs, h) => {
		const selected = model.selected
		const triggerId = `${model.id}-trigger`
		const isVisible = isMounted(model.isOpen, model.animation)
		const searchModel = { ...model, inputValue: Combobox.queryOf(model) }
		return h.div(
			[h.Class("contents")],
			[
				button(
					h,
					{
						variant: "outline",
						size: "default",
						className: "shrink-0 gap-1.5",
						slot: "combobox-trigger",
						attributes: [
							...(isVisible ? [h.AriaControls(`${model.id}-popup`)] : []),
							h.AriaExpanded(model.isOpen),
							h.AriaHasPopup("dialog"),
							h.AriaLabel("Tags"),
							...(model.isOpen
								? [
										h.DataAttribute("popup-open", ""),
										h.DataAttribute("popup-side", model.side),
										h.DataAttribute("pressed", ""),
									]
								: []),
							...(selected.length === 0 ? [h.DataAttribute("placeholder", "")] : []),
							h.Id(triggerId),
							h.Role("combobox"),
							h.Tabindex(0),
							h.OnClick(Combobox.Message.ClickedTriggerOf({ items: inputs.allTags })),
						],
					},
					[
						"Tags",
						...(selected.length === 0
							? []
							: [
									h.span(
										[
											h.Class(
												cn(
													badgeVariants({
														className:
															"ml-1.5 h-4 px-1.5 py-0 font-mono text-4xs",
													}),
												),
											),
											h.DataAttribute("slot", "badge"),
										],
										[String(selected.length)],
									),
								]),
						icon(h, "ChevronDownIcon", { className: "text-muted-foreground" }),
					],
				),
				hiddenInput(h, { ...model, mode: "single", inputValue: selected.join(",") }),
				...(isVisible ? [popup(h, model, searchModel, inputs, triggerId)] : []),
			],
		)
	},
)

const popup = (
	h: HtmlBuilder<Combobox.Message>,
	model: Combobox.Model,
	searchModel: Combobox.Model,
	inputs: Inputs,
	triggerId: string,
): Html =>
	listPopup(h, model, {
		slot: "combobox",
		items: inputs.allTags,
		emptyText: "No matching tags",
		anchorSelector: `#${triggerId}`,
		className: "w-64",
		renderItem: (tag) => [
			h.span(
				[h.Class("flex min-w-0 items-center gap-2")],
				[h.span([h.Class("min-w-0 flex-1 truncate")], [tag])],
			),
		],
		trigger: {
			returnFocusId: triggerId,
			header: h.div(
				[h.Class("border-border border-b p-2")],
				[
					inputField(h, searchModel, {
						items: inputs.allTags,
						placeholder: "Filter tags…",
						size: "sm",
						showTrigger: false,
						hasDismiss: false,
						startAddon: icon(h, "MagnifierIcon"),
					}),
				],
			),
			footer:
				model.selected.length === 0
					? []
					: [
							h.div(
								[h.Class("border-border border-t p-1.5")],
								[
									button(
										h,
										{
											className: "w-full justify-start text-muted-foreground",
											size: "sm",
											variant: "ghost",
											attributes: [h.OnClick(Combobox.Message.ClearedSelection())],
										},
										["Clear tags"],
									),
								],
							),
						],
		},
	})
