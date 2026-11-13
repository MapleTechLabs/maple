import type { Attribute, HtmlBuilder } from "foldkit/html"

/**
 * The keyboard-focused row: the `data-focused` marker a row kit sets and the look it draws for it.
 * A list page moves it with J / K (`page/kit/list-keys`); it is not DOM focus.
 */
export const ROW_FOCUSED_CLASS =
	"data-[focused]:bg-surface-strong data-[focused]:ring-1 data-[focused]:ring-ring data-[focused]:ring-inset"

/** The marker on the focused row, nothing on the others. */
export const rowFocusAttributes = <M>(
	h: HtmlBuilder<M>,
	isFocused: boolean | undefined,
): ReadonlyArray<Attribute<M>> => (isFocused === true ? [h.DataAttribute("focused", "true")] : [])
