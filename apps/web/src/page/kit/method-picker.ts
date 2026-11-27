import type { Html, HtmlBuilder } from "foldkit/html"
import { Array as Arr } from "effect"
import { icon } from "@maple/views/ui/icon"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { toolMark, type ToolId } from "./tool-marks"

/** How a setup is done (Helm, Alchemy, Terraform, CloudShell...): one tool picked, each with its mark, after an optional label. */
export const methodPicker = <T extends ToolId, M>(
	h: HtmlBuilder<M>,
	config: Readonly<{
		/** What the choice is, shown before it ("Install with"); without it, only `ariaLabel` names it (beside a heading). */
		label?: string
		ariaLabel?: string
		methods: ReadonlyArray<T>
		value: T
		onChange: (method: T) => M
	}>,
): Html => {
	const select = segmentedSelect(h, {
		options: Arr.map(config.methods, (method) => {
			const mark = toolMark(method)
			return { value: method, label: mark.label, icon: icon(h, mark.icon, { size: 14 }) }
		}),
		value: config.value,
		onChange: config.onChange,
		size: "sm",
		ariaLabel: config.label ?? config.ariaLabel ?? "Setup method",
	})
	return config.label === undefined
		? select
		: hstack(h, { gap: "3", align: "center", wrap: true }, [
				typography(h, { size: "sm", weight: "medium" }, [config.label]),
				select,
			])
}
