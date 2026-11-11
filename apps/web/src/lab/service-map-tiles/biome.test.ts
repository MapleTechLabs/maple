import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { biomeOf, BIOMES, biomesFor } from "./biome"

const idsOf = (namespaces: ReadonlyArray<string>) =>
	Arr.map([...biomesFor(namespaces)], ([namespace, biome]) => [namespace, biome.id] as const)

describe("biomesFor", () => {
	const seven = ["edge", "storefront", "checkout", "identity", "platform", "data", "external"]

	it("gives every namespace a biome of its own while there are enough to go round", () => {
		const biomes = biomesFor(seven)
		expect(biomes.size).toBe(seven.length)
		expect(new Set(Arr.map([...biomes.values()], (biome) => biome.id)).size).toBe(seven.length)
	})

	it("does not depend on the order the namespaces come in, or on repeats", () => {
		expect(idsOf([...seven].reverse())).toEqual(idsOf(seven))
		expect(idsOf([...seven, "edge", "data"])).toEqual(idsOf(seven))
	})

	it("keeps a namespace's biome when an unrelated namespace joins the map", () => {
		const alone = biomesFor(["checkout"])
		const joined = biomesFor(["checkout", "storefront"])
		expect(biomeOf(joined, "checkout").id).toBe(biomeOf(alone, "checkout").id)
	})

	it("shares biomes only once the namespaces outnumber them", () => {
		const many = Arr.makeBy(BIOMES.length + 3, (index) => `team-${index}`)
		const used = Arr.map([...biomesFor(many).values()], (biome) => biome.id)
		expect(new Set(used).size).toBe(BIOMES.length)
		expect(used).toHaveLength(many.length)
	})

	it("falls back to a biome for a namespace that is not on the map", () => {
		expect(Arr.map(BIOMES, (biome) => biome.id)).toContain(biomeOf(biomesFor(seven), "nowhere").id)
	})
})
