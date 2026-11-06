import type { SectionTarget } from "@maple/domain/http"
import { Array as Arr, String as Str } from "effect"

// The widget menu's "Move to" items carry their destination in the item value.

const SEPARATOR = "\u0000"
const PREFIX = "move"

export const moveValue = (target: SectionTarget): string =>
	target === null ? `${PREFIX}${SEPARATOR}` : Arr.join([PREFIX, target.sectionId, target.tabId], SEPARATOR)

/** The destination a "Move to" value names; `undefined` for any other menu value. */
export const moveTargetOf = (value: string): { readonly target: SectionTarget } | undefined => {
	const [prefix, sectionId, tabId] = Str.split(SEPARATOR)(value)
	if (prefix !== PREFIX || sectionId === undefined) return undefined
	return sectionId === "" || tabId === undefined ? { target: null } : { target: { sectionId, tabId } }
}
