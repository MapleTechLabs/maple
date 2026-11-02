import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { colorInput } from "@maple/views/ui/color-input"
import { field, fieldGroupLabel, type FieldState } from "@maple/views/ui/field"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { input } from "@maple/views/ui/input"
import type { EditorState } from "./editor-state"
import { Message } from "./message"
import { typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"

type H = HtmlBuilder<Message>

const IDLE: FieldState = { isInvalid: false, isDirty: false, isFilled: false, isFocused: false, isTouched: false }

/** `Thresholds`: a colour, a value and a remove button per line, then "+ Add threshold". */
export const thresholds = (h: H, state: EditorState): Html =>
	field(
		h,
		{ className: "items-stretch gap-1.5", state: IDLE },
		[
			fieldGroupLabel(h, { isEyebrow: true }, "Thresholds"),
			vstack(h, { gap: "1.5" },
				[
					...state.thresholds.map((threshold, index) =>
						hstack(h, { gap: "1.5" },
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
										className: typographyClass({ tone: "muted", hoverTone: "foreground" }),
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
