import { describe, expect, it } from "vitest"
import { Array as Arr, String as Str } from "effect"
import { MARKER_CARD_COMMITS } from "./marker-card"
import type { CommitMarker } from "./marker-layout"
import { markerShas } from "./markers"

const sha = (index: number) => Str.padStart(40, "0")(index.toString(16))

const marker = (bucket: string, shas: ReadonlyArray<string>): CommitMarker => ({
	bucket,
	label: "",
	commits: Arr.map(shas, (value) => ({ sha: value, count: 1 })),
})

describe("markerShas", () => {
	it("looks up every commit a grouped marker's card lists, not only the representative", () => {
		const shas = markerShas([marker("b0", [sha(1), sha(2), sha(3)]), marker("b1", [sha(4)])])
		expect(shas).toEqual([sha(1), sha(2), sha(3), sha(4)])
	})

	it("skips refs that are not git shas and stops at the card's commit limit", () => {
		const many = Arr.makeBy(MARKER_CARD_COMMITS + 3, (index) => sha(index + 1))
		const shas = markerShas([marker("b0", ["v1.2.0", ...many])])
		expect(shas).toEqual(many.slice(0, MARKER_CARD_COMMITS - 1))
	})
})
