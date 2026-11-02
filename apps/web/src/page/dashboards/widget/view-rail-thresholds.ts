import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { colorInput } from "../../../ui/color-input"
import { field, fieldGroupLabel, type FieldState } from "../../../ui/field"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { input } from "../../../ui/input"
import type { EditorState } from "./editor-state"
import { Message } from "./message"

type H = HtmlBuilder<Message>

const IDLE: FieldState = { isInvalid: false, isDirty: false, isFilled: false, isFocused: false, isTouched: false }

/** `Thresholds`: a colour, a value and a remove button per line, then "+ Add threshold". */
export const thresholds = (h: H, state: EditorState): Html =>
	field(
		h,
		{ className: "items-stretch gap-1.5", state: IDLE },
		[
			fieldGroupLabel(h, { isEyebrow: true }, "Thresholds"),
			h.div(
				[h.Class("flex flex-col gap-1.5")],
				[
					...state.thresholds.map((threshold, index) =>
						h.div(
							[h.Class("flex items-center gap-1.5")],
							[
								colorInput(h, {
									value: threshold.color.startsWith("#") ? threshold.color : "#ef4444",
									label: "Threshold color",
									onInput: (color) => Message.ChangedThresholdColor({ index, color }),
								}),
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
										className: "text-muted-foreground hover:text-foreground active:text-foreground",
										attributes: [h.OnClick(Message.ClickedRemoveThreshold({ index }))],
									},
									[icon(h, "XmarkIcon")],
								),
							],
						),
					),
					button(
						h,
						{
							variant: "dashed",
							attributes: [h.OnClick(Message.ClickedAddThreshold())],
						},
						["+ Add threshold"],
					),
				],
			),
		],
	)
