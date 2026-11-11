// The landscape's colours, without three, so the DOM chrome can read them too.

export interface TilePalette {
	readonly night: boolean
	/** The soil and the darker soil of a tile's cut sides; the lip of growth above them is the biome's. */
	readonly soil: string
	readonly soilShade: string
	/** The shore of a lake or a pond, and the grass a lake tile is cut from. */
	readonly sand: string
	readonly bank: string
	readonly reed: string
	readonly road: string
	readonly water: string
	readonly waterDeep: string
	readonly lily: string
	readonly snow: string
	readonly walls: ReadonlyArray<string>
	/** Roofs of the data tiles and the keeps, whatever the biome. */
	readonly slates: ReadonlyArray<string>
	readonly dome: string
	readonly stone: string
	readonly stoneLight: string
	readonly rock: string
	readonly banner: string
	readonly lamp: string
	readonly timber: string
	/** Sawn planks: barns, market counters. */
	readonly plank: string
	/** A window pane by day; at night the panes take the lamp's colour. */
	readonly glass: string
	readonly awnings: ReadonlyArray<string>
	readonly sail: string
	readonly gravel: string
	readonly steel: string
	readonly ink: string
	/** Carts and engines on a healthy link; a failing link's carry its health colour. */
	readonly cargo: string
	readonly engine: string
	/** A mallard: body, head and bill. */
	readonly duck: string
	readonly duckHead: string
	readonly bill: string
	/** An empty cell a held tile may be put on, and the one under the pointer. */
	readonly slot: string
	readonly slotEdge: string
	readonly slotHover: string
	readonly selected: string
	readonly sun: string
	readonly sunPower: number
	readonly sky: string
	readonly bounce: string
	readonly skyPower: number
	/** How far unrelated tiles sink back when one is selected. */
	readonly dim: string
}

const DAY: TilePalette = {
	night: false,
	soil: "#dcc9a0",
	soilShade: "#b9a27a",
	sand: "#efe3c0",
	bank: "#bcd69c",
	reed: "#7d9a4c",
	road: "#e7d3a6",
	water: "#69c3cf",
	waterDeep: "#4fb0c2",
	lily: "#6faa52",
	snow: "#f6f8f6",
	walls: ["#f6efdc", "#f1e6cc", "#f8f3e6", "#ecdfc4"],
	slates: ["#6f8fa6", "#5f8198", "#86a3b5"],
	dome: "#eef4f4",
	stone: "#d8c8a6",
	stoneLight: "#ebdfc4",
	rock: "#b9b4a6",
	banner: "#c8553d",
	lamp: "#ffd978",
	timber: "#8a6a48",
	plank: "#c9a77c",
	glass: "#566b7c",
	awnings: ["#c8553d", "#e9b949", "#f6efdc", "#5f8198"],
	sail: "#fbf6ea",
	gravel: "#c4b696",
	steel: "#5d554b",
	ink: "#3b352d",
	cargo: "#8a6a48",
	engine: "#3f6b73",
	duck: "#9a8468",
	duckHead: "#2f6b4f",
	bill: "#e2a336",
	slot: "#e9dcc0",
	slotEdge: "#a8997a",
	slotHover: "#f5a524",
	selected: "#f5a524",
	sun: "#fff4e0",
	sunPower: 2.6,
	sky: "#ffffff",
	bounce: "#c9d6b0",
	skyPower: 2.0,
	dim: "#cdd6d2",
}

const NIGHT: TilePalette = {
	...DAY,
	night: true,
	soil: "#c4b189",
	soilShade: "#9c876a",
	ink: "#1d1a16",
	slot: "#cfc4aa",
	slotEdge: "#e9dcc0",
	sun: "#ffe9c4",
	sunPower: 2.2,
	sky: "#e6ecf0",
	bounce: "#8fa08a",
	skyPower: 1.8,
	dim: "#a3aeab",
}

export const tilePalette = (dark: boolean): TilePalette => (dark ? NIGHT : DAY)
