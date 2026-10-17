import { formatNumber } from "@maple/domain/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Checkbox from "../checkbox"
import { label } from "../label"

// Port of `SingleCheckboxFilter` (packages/ui/src/components/filters/filter-section.tsx).
// TODO(description): the info-mark `description` popover is not ported (no caller passes one yet).

export type SingleCheckboxFilterConfig<M> = Readonly<{
	title: string
	isChecked: boolean
	onToggle: M
	count?: number
}>

export const singleCheckboxFilter = <M>(h: HtmlBuilder<M>, config: SingleCheckboxFilterConfig<M>): Html => {
	const inputId = `filter-${config.title}`
	return h.div(
		[h.Class("flex items-center gap-2 py-1.5")],
		[
			...Checkbox.view(h, {
				model: { isChecked: config.isChecked },
				toParentMessage: () => config.onToggle,
				id: `${inputId}-checkbox`,
				inputId,
			}),
			label(
				h,
				{
					className:
						"flex-1 min-w-0 flex items-center gap-1.5 cursor-pointer text-xs text-foreground font-normal",
					attributes: [h.For(inputId), h.Id(Checkbox.labelId(inputId)), h.Title(config.title)],
				},
				[h.span([h.Class("truncate")], [config.title])],
			),
			...(config.count === undefined
				? []
				: [
						h.span(
							[h.Class("text-xs text-muted-foreground tabular-nums")],
							[formatNumber(config.count)],
						),
					]),
		],
	)
}
