import type { Attribute, HtmlBuilder } from "foldkit/html"

/**
 * The keyboard-focused row: the `data-focused` marker a row kit sets and the look it draws for it.
 * A list page moves it with J / K (`page/kit/list-keys`); it is not DOM focus.
 */
export const ROW_FOCUSED_CLASS =
	"data-[focused]:bg-surface-strong data-[focused]:ring-1 data-[focused]:ring-ring data-[focused]:ring-inset"

/** `data-list-row` on every row of a keyed list, so the keys can tell one that holds DOM focus. */
export const LIST_ROW_SELECTOR = "[data-list-row]"

/** A keyed list's row: `data-list-row`, and `data-focused` on the focused one. Nothing for a row no list keys. */
export const rowFocusAttributes = <M>(
	h: HtmlBuilder<M>,
	isFocused: boolean | undefined,
): ReadonlyArray<Attribute<M>> =>
	isFocused === undefined
		? []
		: [h.DataAttribute("list-row", ""), ...(isFocused ? [h.DataAttribute("focused", "true")] : [])]
