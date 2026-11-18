import { describe, expect, test } from "vitest"
import { init, Message, update } from "./chart"

/** The stored hidden names after a legend click on `key`, with `keys` the series of the data on screen. */
const afterToggle = (stored: ReadonlyArray<string>, key: string, keys: ReadonlyArray<string>) =>
	update({ ...init(), hiddenKeys: stored }, Message.ToggledLegendSeries({ key, keys })).model.hiddenKeys

describe("a legend click", () => {
	test("hides a visible series and shows a hidden one", () => {
		expect(afterToggle([], "api", ["api", "web"])).toEqual(["api"])
		expect(afterToggle(["api"], "api", ["api", "web"])).toEqual([])
	})

	test("never hides the last series left", () => {
		expect(afterToggle(["api"], "web", ["api", "web"])).toEqual(["api"])
	})

	test("keeps the names of other data for when it returns", () => {
		expect(afterToggle(["aws"], "api", ["api", "web"])).toEqual(["aws", "api"])
	})

	test("acts on what is shown: with every series remembered as hidden, all are shown and the click hides its own", () => {
		expect(afterToggle(["api", "worker"], "api", ["api", "worker"])).toEqual(["api"])
	})
})
