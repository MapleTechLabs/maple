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

	it("keeps a namespace's biome when one that sorts before it joins and asks for another", () => {
		const alone = biomeOf(biomesFor(["checkout"]), "checkout").id
		// Names that sort ahead of every namespace on the map and hash to some other biome.
		const ahead = Arr.filter(
			Arr.makeBy(12, (index) => `a-team-${index}`),
			(name) => biomeOf(biomesFor([name]), name).id !== alone,
		)
		expect(ahead.length).toBeGreaterThan(0)
		expect(Arr.map(ahead, (name) => biomeOf(biomesFor([name, "checkout"]), "checkout").id)).toEqual(
			Arr.map(ahead, () => alone),
		)
	})

	it("leaves every namespace that asked first where it was when others join asking for other biomes", () => {
		const before = biomesFor(seven)
		const solo = (name: string) => biomeOf(biomesFor([name]), name).id
		const firsts = Arr.filter(seven, (name) => solo(name) === biomeOf(before, name).id)
		const held = new Set(Arr.map(firsts, solo))
		const joiners = Arr.filter(
			Arr.makeBy(20, (index) => `a-team-${index}`),
			(name) => !held.has(solo(name)),
		)
		expect(joiners.length).toBeGreaterThan(0)
		const after = biomesFor([...seven, ...joiners])
		expect(Arr.map(firsts, (name) => biomeOf(after, name).id)).toEqual(
			Arr.map(firsts, (name) => biomeOf(before, name).id),
		)
	})

	it("falls back to the meadow for a namespace that is not on the map", () => {
		expect(biomeOf(biomesFor(seven), "nowhere").id).toBe("meadow")
	})
})
