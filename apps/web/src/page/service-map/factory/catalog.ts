import { BuildingType } from "@maple/domain/http"
import { Array as Arr, String as Str } from "effect"
import type { Node3D, Node3DKind } from "../../../components/service-map/three/types"

// What can be built. Each catalog is data keyed by its type literal, so a new building (or a
// later decoration catalog) is one entry plus its model in the scene.

/** Cells covered along x (`width`) and z (`depth`) at rotation 0. */
export interface Footprint {
	readonly width: number
	readonly depth: number
}

export interface CatalogEntry {
	readonly label: string
	readonly description: string
	readonly footprint: Footprint
}

export type Catalog<Key extends string, Entry extends CatalogEntry> = { readonly [K in Key]: Entry }

export interface BuildingSpec extends CatalogEntry {
	/** Node kinds this building reads naturally for; the picker lists these first. */
	readonly suits: ReadonlyArray<Node3DKind>
}

/** Machines are 2x2 modules (1.6 units): a 3x3 footprint leaves a margin for belts. */
const MACHINE: Footprint = { width: 3, depth: 3 }

export const BUILDINGS = {
	processor: {
		label: "Processor",
		description: "A workshop that handles requests.",
		footprint: MACHINE,
		suits: ["service"],
	},
	tank: {
		label: "Storage tank",
		description: "Holds data at rest.",
		footprint: MACHINE,
		suits: ["database"],
	},
	loader: {
		label: "Loading bay",
		description: "Moves work onto and off conveyors.",
		footprint: MACHINE,
		suits: ["queue", "service"],
	},
	gateway: {
		label: "Gateway",
		description: "Where traffic enters the factory.",
		footprint: MACHINE,
		suits: ["edge", "service"],
	},
	shed: {
		label: "Shed",
		description: "A third-party dependency outside the walls.",
		footprint: MACHINE,
		suits: ["external"],
	},
} satisfies Catalog<BuildingType, BuildingSpec>

/** Every building type, in catalog order. */
export const BUILDING_TYPES: ReadonlyArray<BuildingType> = BuildingType.literals

/** Building types for a node kind: the ones that suit it first, then the rest. */
export const buildingsFor = (kind: Node3DKind): ReadonlyArray<BuildingType> => {
	const suits = (type: BuildingType) => {
		const spec: BuildingSpec = BUILDINGS[type]
		return spec.suits.includes(kind)
	}
	return [...Arr.filter(BUILDING_TYPES, suits), ...Arr.filter(BUILDING_TYPES, (type) => !suits(type))]
}

export type BuildingNode = Pick<Node3D, "id" | "kind"> & Partial<Pick<Node3D, "platform">>

/** The building a node gets until someone picks another. The single source for `machineKind`
 * in `three/machines.ts`, which should import this instead of keeping its own copy. */
export const defaultBuilding = (node: BuildingNode): BuildingType => {
	if (node.kind === "database") return "tank"
	if (node.kind === "queue" || Str.endsWith("worker")(node.id)) return "loader"
	if (node.kind === "external") return "shed"
	if (node.kind === "edge" || node.platform === "cloudflare") return "gateway"
	return "processor"
}
