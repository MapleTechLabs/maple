import { Array as Arr, Option, Order, String as Str } from "effect"

// Every namespace is its own kind of country. The biome decides a tile's ground, its trees, its
// roofs and what its villages send down the road; the node's kind still decides the landmark.

export type TreeKind = "broadleaf" | "pine" | "maple" | "snowpine"

export interface Biome {
	readonly id: string
	readonly label: string
	/** The chip that stands for the biome in the legend. */
	readonly swatch: string
	readonly grounds: ReadonlyArray<string>
	/** The lip of growth on a tile's cut side. */
	readonly turf: string
	/** The worn ground of a village. */
	readonly yard: string
	readonly trees: TreeKind
	readonly foliage: ReadonlyArray<string>
	/** How wooded the biome is: scales the trees a tile would otherwise have. */
	readonly woodland: number
	readonly roofs: ReadonlyArray<string>
	readonly fields: ReadonlyArray<string>
	/** Fields, boulders and ponds every tile of the biome gets, whatever stands on it. */
	readonly fieldCount: number
	readonly boulders: number
	readonly hasPond: boolean
	/** What the biome's tiles send along their roads and railways. */
	readonly produce: { readonly label: string; readonly paint: string }
}

const TERRACOTTA = ["#d9603a", "#cf5330", "#e2764a", "#c84a2c", "#de6b3f"]
const GOLDS = ["#f0c95a", "#e9b949", "#f5d572", "#e3ad3c"]

const MEADOW: Biome = {
	id: "meadow",
	label: "Meadow",
	swatch: "#b9cf86",
	grounds: ["#cbd998", "#c3d38e", "#d3dea3"],
	turf: "#a8c078",
	yard: "#efe3c0",
	trees: "broadleaf",
	foliage: ["#5d9a4a", "#6faa52", "#4f8a45", "#82b65c"],
	woodland: 1,
	roofs: TERRACOTTA,
	fields: GOLDS,
	fieldCount: 1,
	boulders: 0,
	hasPond: false,
	produce: { label: "crates", paint: "#c79a5b" },
}

export const BIOMES: ReadonlyArray<Biome> = [
	MEADOW,
	{
		id: "farmland",
		label: "Farmland",
		swatch: "#e9c552",
		grounds: ["#dfd98f", "#e4dc98", "#d8d488"],
		turf: "#c2bd6c",
		yard: "#f1e4b8",
		trees: "broadleaf",
		foliage: ["#7fae4e", "#93b95a", "#6c9d45"],
		woodland: 0.45,
		roofs: ["#b5533a", "#c1603f", "#a94a34"],
		fields: [...GOLDS, "#cfa53a", "#d9c55e"],
		fieldCount: 5,
		boulders: 0,
		hasPond: false,
		produce: { label: "grain", paint: "#e9b949" },
	},
	{
		id: "pinewood",
		label: "Pinewood",
		swatch: "#4a8752",
		grounds: ["#9dbb7c", "#93b373", "#a5c184"],
		turf: "#7fa364",
		yard: "#e3dab6",
		trees: "pine",
		foliage: ["#3f7a4a", "#356e44", "#4a8752", "#2f6540"],
		woodland: 2.4,
		roofs: ["#8a5a3c", "#9b6846", "#7b4f36"],
		fields: GOLDS,
		fieldCount: 0,
		boulders: 1,
		hasPond: false,
		produce: { label: "timber", paint: "#8a6a48" },
	},
	{
		id: "maple-grove",
		label: "Maple grove",
		swatch: "#e2752f",
		grounds: ["#e3d39a", "#dccb8e", "#e8d9a6"],
		turf: "#c9b57a",
		yard: "#f2e6c4",
		trees: "maple",
		foliage: ["#e2752f", "#d9542b", "#f0a431", "#c8452a", "#eebb45"],
		woodland: 1.6,
		roofs: ["#a3523a", "#8f4a36", "#b45f41"],
		fields: GOLDS,
		fieldCount: 0,
		boulders: 0,
		hasPond: false,
		produce: { label: "syrup", paint: "#d98a2b" },
	},
	{
		id: "highland",
		label: "Highland",
		swatch: "#a9a69c",
		grounds: ["#c5c9a3", "#bcc19a", "#cdd0ab"],
		turf: "#a3a884",
		yard: "#e2ddc6",
		trees: "pine",
		foliage: ["#5e8a5a", "#527c50", "#6a9462"],
		woodland: 0.55,
		roofs: ["#6f8fa6", "#5f8198", "#86a3b5"],
		fields: GOLDS,
		fieldCount: 0,
		boulders: 8,
		hasPond: false,
		produce: { label: "stone", paint: "#a9a69c" },
	},
	{
		id: "lakeland",
		label: "Lakeland",
		swatch: "#5fa8c4",
		grounds: ["#bfdcae", "#b5d5a4", "#c8e2b6"],
		turf: "#9ac58d",
		yard: "#f3ebcf",
		trees: "broadleaf",
		foliage: ["#5fa880", "#6fb58c", "#4f9a74"],
		woodland: 0.8,
		roofs: ["#4f86a8", "#5d94b5", "#447a9c"],
		fields: GOLDS,
		fieldCount: 0,
		boulders: 0,
		hasPond: true,
		produce: { label: "fish", paint: "#5fa8c4" },
	},
	{
		id: "snowfield",
		label: "Snowfield",
		swatch: "#e6ece9",
		grounds: ["#eef2ef", "#e6ece9", "#f4f6f3"],
		turf: "#d5dedb",
		yard: "#f6f4ec",
		trees: "snowpine",
		foliage: ["#3f6f52", "#356549", "#487a5b"],
		woodland: 1.1,
		roofs: ["#8f3f35", "#9c4a3d", "#7f382f"],
		fields: GOLDS,
		fieldCount: 0,
		boulders: 2,
		hasPond: false,
		produce: { label: "ice", paint: "#bfe0ea" },
	},
]

const hashOf = (text: string): number =>
	Arr.reduce(
		Arr.fromIterable(text),
		2166136261,
		(hash, char) => Math.imul(hash ^ Option.getOrElse(Str.codePointAt(char, 0), () => 0), 16777619) >>> 0,
	)

/** One biome per namespace. A namespace keeps asking for the same biome whatever else is on the
 * map; two that ask for the same one are told apart by name, the later taking the next free
 * biome, so namespaces only share a biome once there are more of them than biomes. */
export const biomesFor = (namespaces: ReadonlyArray<string>): ReadonlyMap<string, Biome> => {
	const names = Arr.sort(Arr.dedupe(namespaces), Order.String)
	const taken = new Set<number>()
	const assigned = new Map<string, Biome>()
	Arr.forEach(names, (name) => {
		const wanted = hashOf(name) % BIOMES.length
		const free = Arr.findFirst(
			Arr.makeBy(BIOMES.length, (step) => (wanted + step) % BIOMES.length),
			(index) => !taken.has(index),
		)
		const index = Option.getOrElse(free, () => wanted)
		taken.add(index)
		assigned.set(name, BIOMES[index] ?? MEADOW)
	})
	return assigned
}

export const biomeOf = (biomes: ReadonlyMap<string, Biome>, namespace: string): Biome =>
	biomes.get(namespace) ?? MEADOW
