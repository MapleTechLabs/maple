import { cn } from "@maple/ui/lib/utils"
import { eyebrowVariants } from "@maple/ui/styles/ui/eyebrow"
import { fieldLabelStyles, fieldStyles } from "@maple/ui/styles/ui/field"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { input } from "../../../ui/input"
import type { EditorState } from "./editor-state"
import { Message } from "./message"

type H = HtmlBuilder<Message>

const RAIL_LABEL_CLASS = cn(eyebrowVariants({ variant: "label" }), "sm:text-2xs sm:leading-normal")

/** `Thresholds`: a colour, a value and a remove button per line, then "+ Add threshold". */
export const thresholds = (h: H, state: EditorState): Html =>
	h.div(
		[h.Class(cn(fieldStyles, "items-stretch gap-1.5")), h.DataAttribute("slot", "field")],
		[
			h.label(
				[h.Class(cn(fieldLabelStyles, RAIL_LABEL_CLASS)), h.DataAttribute("slot", "field-label")],
				["Thresholds"],
			),
			h.div(
				[h.Class("flex flex-col gap-1.5")],
				[
					...state.thresholds.map((threshold, index) =>
						h.div(
							[h.Class("flex items-center gap-1.5")],
							[
								h.input([
									h.Type("color"),
									h.Value(threshold.color.startsWith("#") ? threshold.color : "#ef4444"),
									h.OnInput((color) => Message.ChangedThresholdColor({ index, color })),
									h.Class(
										"h-8 w-8 shrink-0 cursor-pointer rounded-sm border bg-transparent p-0.5",
									),
									h.AriaLabel("Threshold color"),
								]),
								input(h, {
									id: `widget-editor-threshold-${index}`,
									type: "number",
									className: "h-8",
									attributes: [
										h.Value(String(threshold.value)),
										h.OnInput((value) => Message.ChangedThresholdValue({ index, value })),
									],
								}),
								iconButton(
									h,
									{
										variant: "outline",
										size: "icon",
										label: "Remove threshold",
										className: "text-muted-foreground hover:text-foreground",
										attributes: [h.OnClick(Message.ClickedRemoveThreshold({ index }))],
									},
									[icon(h, "XmarkIcon")],
								),
							],
						),
					),
					h.button(
						[
							h.Type("button"),
							h.OnClick(Message.ClickedAddThreshold()),
							h.Class(
								"h-8 rounded-md border border-dashed text-xs text-muted-foreground transition-colors hover:text-foreground",
							),
						],
						["+ Add threshold"],
					),
				],
			),
		],
	)
