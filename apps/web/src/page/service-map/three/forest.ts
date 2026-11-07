import type { FactoryLink } from "../../../components/service-map/three/factory-routing"
import {
	drawBridge,
	drawCampfire,
	drawCreek,
	drawDeer,
	drawFence,
	drawFox,
	drawMeadow,
	drawPerch,
	drawPlant,
	drawSteppingStones,
} from "../../../components/service-map/three/maple-scenery"
import { lakeLoop } from "../../../components/service-map/three/maple-scenery-field"
import {
	drawDock,
	drawHill,
	drawLake,
	drawMound,
	drawPath,
} from "../../../components/service-map/three/maple-scenery-land"
import {
	forestPlan,
	groundOf,
	type Growth,
	type Plant,
	landmarks,
	openGround,
	worldOf,
} from "../../../components/service-map/three/maple-scenery-plan"
import {
	type Bounds,
	prototypes,
	type Sketch,
} from "../../../components/service-map/three/maple-scenery-sketch"
import type { InkPalette } from "../../../components/service-map/three/palette"
import type { District, SpatialLayout } from "../../../components/service-map/three/spatial-layout"
import type * as THREE from "three"
import { birds, blimp, campfire, deerHead, ducks } from "./critters"
import { type Child, group, type Running, type Scope, sketchDrawing, type Vec3 } from "./kit"
import { fallingLeaves, fireflies, isNight, leafLitter, ripples } from "./life"
import { Array as Arr, Order } from "effect"
import type { LeafSource } from "./falling-leaves"

const LOW_GROWTH: ReadonlySet<Growth> = new Set<Growth>([
	"rock",
	"bush",
	"log",
	"mushrooms",
	"sapling",
	"stump",
	"grass",
])

interface ForestProps {
	bounds: Bounds
	districts: ReadonlyArray<District>
	belts: ReadonlyArray<FactoryLink>
	palette: InkPalette
	running: Running
}

/** Maple and birch crowns near the clearing, where falling leaves are seen; up to 40, nearest
 * first. Crown height and spread follow `drawPlant`'s scale for each tree. */
const leafSources = (plants: ReadonlyArray<Plant>, floor: number): ReadonlyArray<LeafSource> =>
	Arr.map(
		Arr.take(
			Arr.sort(
				Arr.filter(
					plants,
					(plant) => (plant.kind === "maple" || plant.kind === "birch") && plant.gap < 6,
				),
				Order.mapInput(Order.Number, (plant: Plant) => plant.gap),
			),
			40,
		),
		(plant) => {
			const scale = (0.85 + plant.seed * 0.5) * plant.size
			return {
				x: plant.x,
				z: plant.z,
				top: floor + (plant.kind === "maple" ? 1.1 : 1.3) * scale,
				radius: (plant.kind === "maple" ? 0.32 : 0.22) * scale,
			}
		},
	)

/** One merged drawing for meadow, woods and landmarks, plus the few things that move. */
export function mapleForest(
	scope: Scope,
	{ bounds, districts, belts, palette, running }: ForestProps,
): THREE.Group {
	const world = worldOf(districts, belts)
	const marks = landmarks(world)
	const ground = groundOf(world, marks)
	const plants = forestPlan(world, marks, ground)
	const water = lakeLoop(world.lake)
	const floor = bounds.floor
	const draw = (sketch: Sketch) => {
		const stock = prototypes()
		drawMeadow(sketch, stock, palette, world.meadow, (x, z) => openGround(world, marks, ground, x, z))
		Arr.forEach(ground.mounds, (layers) => drawMound(sketch, stock, palette, layers))
		Arr.forEach(ground.paths, (path) => drawPath(sketch, palette, path))
		drawHill(sketch, stock, palette, world.hill)
		drawLake(sketch, stock, palette, world.lake)
		drawDock(sketch, stock, palette, marks.dock.at, marks.dock.yaw)
		Arr.forEach(plants, (plant) => drawPlant(sketch, stock, palette, plant, floor))
		drawCreek(sketch, stock, palette, world.creek, floor, (x, z) => world.lake.rim(x, z) > 0.05)
		drawBridge(sketch, stock, palette, marks.bridge.at, marks.bridge.yaw)
		drawSteppingStones(sketch, stock, palette, world.creek, floor)
		drawFence(sketch, stock, palette, marks.fence, floor)
		drawDeer(sketch, stock, palette, marks.deer)
		drawCampfire(sketch, stock, palette, marks.campfire)
		drawFox(sketch, stock, palette, marks.fox)
		drawPerch(sketch, stock, palette, marks.perch)
		stock.dispose()
	}
	// Fireflies hover over low growth, where no crown hides them, well clear of the zones.
	const glades = Arr.map(
		Arr.filter(plants, (plant) => LOW_GROWTH.has(plant.kind) && plant.gap > 1.4).slice(0, 24),
		(plant): Vec3 => [plant.x, floor, plant.z],
	)
	const night = isNight(palette)
	return group({}, [
		sketchDrawing(draw, palette.ink),
		ripples(scope, { creek: world.creek, floor, palette, running }),
		ducks(scope, { water, floor, palette, running }),
		birds(scope, { bounds, palette, running }),
		blimp(scope, { bounds, palette, running }),
		campfire(scope, { at: marks.campfire, palette, night, running }),
		deerHead(scope, { at: marks.deer, palette, running }),
		night ? fireflies(scope, { anchors: glades, floor, palette, running }) : null,
		leafLitter(scope, { districts, palette }),
		fallingLeaves(scope, {
			world: { sources: leafSources(plants, floor), districts, floor },
			palette,
			running,
		}),
	])
}

/** The sugar-bush round the map, framed on the districts. */
export function scenery(
	scope: Scope,
	{
		layout,
		belts,
		palette,
		running,
	}: { layout: SpatialLayout; belts: ReadonlyArray<FactoryLink>; palette: InkPalette; running: Running },
): Child {
	if (layout.districts.length === 0) return null
	const bounds: Bounds = {
		minX: Math.min(...Arr.map(layout.districts, (d) => d.position[0] - d.width / 2)),
		maxX: Math.max(...Arr.map(layout.districts, (d) => d.position[0] + d.width / 2)),
		minZ: Math.min(...Arr.map(layout.districts, (d) => d.position[2] - d.depth / 2)),
		maxZ: Math.max(...Arr.map(layout.districts, (d) => d.position[2] + d.depth / 2)),
		floor: -0.14,
	}
	return mapleForest(scope, { bounds, districts: layout.districts, belts, palette, running })
}
