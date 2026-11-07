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
import { Array as Arr, String as Str } from "effect"

/** A new threshold's colour. It is saved in the widget config, so a hex the picker can show, not a token. */
export const DEFAULT_THRESHOLD_COLOR = "#ef4444"

type H = HtmlBuilder<Message>

const IDLE: FieldState = {
	isInvalid: false,
	isDirty: false,
	isFilled: false,
	isFocused: false,
	isTouched: false,
}

/** `Thresholds`: a colour, a value and a remove button per line, then "+ Add threshold". */
export const thresholds = (h: H, state: EditorState): Html =>
	field(h, { className: "items-stretch gap-1.5", state: IDLE }, [
		fieldGroupLabel(h, { isEyebrow: true }, "Thresholds"),
		vstack(h, { gap: "1.5" }, [
			...Arr.map(state.thresholds, (threshold, index) =>
				hstack(h, { gap: "1.5" }, [
					colorInput(h, {
						value: Str.startsWith("#")(threshold.color)
							? threshold.color
							: DEFAULT_THRESHOLD_COLOR,
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
				]),
			),
			button(
				h,
				{
					variant: "dashed",
					attributes: [h.OnClick(Message.ClickedAddThreshold())],
				},
				["+ Add threshold"],
			),
		]),
	])
