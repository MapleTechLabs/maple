import { Array as Arr, Option } from "effect"
import { describe, expect, test } from "vitest"
import { dismissalOf, SheetHistoryState, sheetParamOf, withSheetParam } from "./sheet-param"

// `?sheet=` in the URL, and how a dismissal leaves the tab's history.

type Entry = Readonly<{ url: string; state: unknown }>

const topOf = (stack: ReadonlyArray<Entry>): Entry => Option.getOrThrow(Arr.last(stack))

/** A tab's history as `pushSheetUrl` and `dismissSheetUrl` move it. */
const open = (stack: ReadonlyArray<Entry>, id: string): ReadonlyArray<Entry> => {
	const top = topOf(stack)
	const state: typeof SheetHistoryState.Type = { mapleSheet: id }
	return [...stack, { url: withSheetParam(top.url, id), state }]
}

const dismiss = (stack: ReadonlyArray<Entry>, id: string): ReadonlyArray<Entry> => {
	const top = topOf(stack)
	const dismissal = dismissalOf(top.state, top.url, id)
	return dismissal._tag === "Back"
		? stack.slice(0, -1)
		: [...stack.slice(0, -1), { url: dismissal.url, state: null }]
}

describe("sheet param", () => {
	test("sets and clears ?sheet= while keeping the other params and the hash", () => {
		expect(withSheetParam("/alerts?tab=rules#top", "new-rule")).toBe(
			"/alerts?tab=rules&sheet=new-rule#top",
		)
		expect(withSheetParam("/alerts?sheet=new-rule&tab=rules", undefined)).toBe("/alerts?tab=rules")
		expect(sheetParamOf("/alerts?sheet=new-rule")).toEqual(Option.some("new-rule"))
		expect(sheetParamOf("/alerts?sheet=")).toEqual(Option.none())
	})

	test("open, Escape, then one Back leaves the page: the dismissal pops the entry it pushed", () => {
		const before: ReadonlyArray<Entry> = [
			{ url: "/services", state: null },
			{ url: "/alerts?tab=rules", state: null },
		]
		const closed = dismiss(open(before, "new-rule"), "new-rule")
		expect(closed).toEqual(before)
		expect(Option.map(Arr.last(closed.slice(0, -1)), (entry) => entry.url)).toEqual(
			Option.some("/services"),
		)
	})

	test("a deep link (or a reload into another tab's entry) replaces the param away", () => {
		const linked: ReadonlyArray<Entry> = [{ url: "/alerts?tab=rules&sheet=new-rule", state: null }]
		expect(dismiss(linked, "new-rule")).toEqual([{ url: "/alerts?tab=rules", state: null }])
		expect(dismissalOf({ mapleSheet: "other" }, "/alerts?sheet=new-rule", "new-rule")).toEqual({
			_tag: "Replace",
			url: "/alerts",
		})
	})
})
