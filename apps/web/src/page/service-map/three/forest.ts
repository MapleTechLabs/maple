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
		ground.mounds.forEach((layers) => drawMound(sketch, stock, palette, layers))
		ground.paths.forEach((path) => drawPath(sketch, palette, path))
		drawHill(sketch, stock, palette, world.hill)
		drawLake(sketch, stock, palette, world.lake)
		drawDock(sketch, stock, palette, marks.dock.at, marks.dock.yaw)
		plants.forEach((plant) => drawPlant(sketch, stock, palette, plant, floor))
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
	const glades = plants
		.filter((plant) => LOW_GROWTH.has(plant.kind) && plant.gap > 1.4)
		.slice(0, 24)
		.map((plant): Vec3 => [plant.x, floor, plant.z])
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
		fallingLeaves(scope, { bounds, palette, running }),
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
		minX: Math.min(...layout.districts.map((d) => d.position[0] - d.width / 2)),
		maxX: Math.max(...layout.districts.map((d) => d.position[0] + d.width / 2)),
		minZ: Math.min(...layout.districts.map((d) => d.position[2] - d.depth / 2)),
		maxZ: Math.max(...layout.districts.map((d) => d.position[2] + d.depth / 2)),
		floor: -0.14,
	}
	return mapleForest(scope, { bounds, districts: layout.districts, belts, palette, running })
}
