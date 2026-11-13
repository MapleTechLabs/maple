import { isDialogOpen, isEditableTarget, pressedKey } from "@maple/ui/lib/keyboard"
import { Array as Arr, Effect, Option, type Stream } from "effect"
import { Command, Dom, Render } from "foldkit"
import type { CallableTaggedStruct } from "foldkit/schema"

// Keyboard row navigation for a list page: the document key stream (J, K, the arrows, Enter and Escape), the focus step and the scroll that keeps the focused row in view.

const NAVIGATION_KEYS = ["j", "J", "k", "K", "ArrowDown", "ArrowUp", "Enter", "Escape"]

/** A focused control keeps its own Enter. */
const keepsEnter = (target: EventTarget | null): boolean => {
	if (!(target instanceof HTMLElement)) return false
	const control = target.closest("a, button, [role='tab'], [role='menuitem'], [role='option'], tr")
	return control instanceof HTMLElement && control.tabIndex >= 0
}

export type ListKeyOptions<M> = Readonly<{
	toMessage: (key: string) => M
	/** The page's own keys beside the navigation set. */
	extraKeys?: ReadonlyArray<string>
	/** Whether something else owns this key right now; by default an open dialog owns them all. */
	isBlocked?: (key: string) => boolean
}>

/** The list's keys from anywhere on the page, while no field has focus and no modifier is held. */
export const listKeys = <M>(options: ListKeyOptions<M>): Stream.Stream<M> => {
	const keys = new Set([...NAVIGATION_KEYS, ...(options.extraKeys ?? [])])
	const isBlocked = options.isBlocked ?? isDialogOpen
	return Dom.streamFromEventFilterMapPreventDefault({
		target: () => document,
		type: "keydown",
		filterMapEvent: (event) => {
			const key = pressedKey(event)
			if (!keys.has(key) || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
				return Option.none()
			if (isEditableTarget(event.target)) return Option.none()
			if (key === "Enter" && keepsEnter(event.target)) return Option.none()
			return isBlocked(key) ? Option.none() : Option.some(options.toMessage(key))
		},
	})
}

/** What a navigation key steps by: down and J forward, up and K back. */
export const listStepOf = (key: string): 1 | -1 | null =>
	key === "j" || key === "J" || key === "ArrowDown"
		? 1
		: key === "k" || key === "K" || key === "ArrowUp"
			? -1
			: null

/** The focus after a step over `count` rows: none goes to the first row, both ends hold. */
export const steppedFocus = (current: number | null, step: 1 | -1, count: number): number | null => {
	if (count <= 0) return current
	if (current === null || current < 0) return 0
	return Math.max(0, Math.min(current + step, count - 1))
}

/** What a list key asks of the page that pressed it. */
export type ListKeyAction =
	| Readonly<{ _tag: "Focus"; index: number | null }>
	| Readonly<{ _tag: "Open"; index: number }>
	| Readonly<{ _tag: "None" }>

/** J / K / arrows move the focus, Enter opens the focused row, Escape clears it. */
export const listKeyAction = (key: string, focusedIndex: number | null, count: number): ListKeyAction => {
	const step = listStepOf(key)
	if (step !== null)
		return count > 0
			? { _tag: "Focus", index: steppedFocus(focusedIndex, step, count) }
			: { _tag: "None" }
	if (key === "Enter" && focusedIndex !== null && focusedIndex < count)
		return { _tag: "Open", index: focusedIndex }
	return key === "Escape" ? { _tag: "Focus", index: null } : { _tag: "None" }
}

/** A live list reorders under its focus, so it keeps the row's id: that id's place among the rows now. */
export const focusedIndexOf = (ids: ReadonlyArray<string>, focusedId: string | null): number | null =>
	focusedId === null ? null : Option.getOrNull(Arr.findFirstIndex(ids, (id) => id === focusedId))

const FOCUSED_ROW = "[data-focused]"

/** A page's scroll that keeps its focused row in view, under its own command name. */
export const scrollFocusedRowCommand = <const Name extends string, const Tag extends string>(
	name: Name,
	completed: CallableTaggedStruct<Tag, Record<never, never>>,
) =>
	Command.define(name, {
		messages: [completed],
		// After the commit that marks the row. A page that draws its rows twice (a table, and a list
		// below `md`) marks both, so the one with a box is the one to scroll; none has nothing to do.
		execute: Effect.gen(function* () {
			yield* Render.afterCommit
			const visible = Arr.findFirst(
				[...document.querySelectorAll<HTMLElement>(FOCUSED_ROW)],
				(row) => row.getClientRects().length > 0,
			)
			if (Option.isSome(visible)) visible.value.scrollIntoView({ block: "nearest" })
			return completed()
		}),
	})
