import { useState } from "react"
import type { InkPalette } from "./appearance"
import type { FactoryLink } from "./factory-routing"
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
} from "./maple-scenery"
import { Birds, Campfire, DeerHead, Ducks } from "./maple-scenery-critters"
import { type Bounds, prototypes, type Sketch, SketchDrawing } from "./maple-scenery-kit"
import { FallingLeaves, Fireflies, isNight, LeafLitter, Ripples } from "./maple-scenery-life"
import { lakeLoop } from "./maple-scenery-field"
import { drawDock, drawHill, drawLake, drawMound, drawPath } from "./maple-scenery-land"
import { forestPlan, groundOf, type Growth, landmarks, openGround, worldOf } from "./maple-scenery-plan"
import type { District } from "./spatial-layout"
import type { Vec3 } from "./types"

const LOW_GROWTH: ReadonlySet<Growth> = new Set([
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
	running: boolean
}

/** The Maple sugar-bush. Planting depends only on zone and belt geometry; metrics refresh
 * the belts array every few seconds, so the plan is keyed on geometry, not identity. */
export function MapleForest(props: ForestProps) {
	const zones = props.districts.map((d) => `${d.id}:${d.position.join(",")}:${d.width}:${d.depth}`)
	const key = [...zones, ...props.belts.map((belt) => belt.geometryKey)].join("|")
	return <MapleWorld key={key} {...props} />
}

/** One merged drawing for meadow, woods and landmarks, plus the few things that move. */
function MapleWorld({ bounds, districts, belts, palette, running }: ForestProps) {
	// Planned once per mount; the parent remounts this when the geometry key changes.
	const [{ world, marks, ground, plants, ducks }] = useState(() => {
		const world = worldOf(districts, belts)
		const marks = landmarks(world)
		const ground = groundOf(world, marks)
		return { world, marks, ground, plants: forestPlan(world, marks, ground), ducks: lakeLoop(world.lake) }
	})
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
	return (
		<group>
			<SketchDrawing key={`${palette.paper}:${palette.ink}`} draw={draw} ink={palette.ink} />
			<Ripples creek={world.creek} floor={floor} palette={palette} running={running} />
			<Ducks water={ducks} floor={floor} palette={palette} running={running} />
			<Birds key={palette.ink} bounds={bounds} palette={palette} running={running} />
			<Campfire at={marks.campfire} palette={palette} night={night} running={running} />
			<DeerHead at={marks.deer} palette={palette} running={running} />
			{night ? (
				<Fireflies
					key={glades.length}
					anchors={glades}
					floor={floor}
					palette={palette}
					running={running}
				/>
			) : null}
			<LeafLitter districts={districts} palette={palette} />
			<FallingLeaves bounds={bounds} palette={palette} running={running} />
		</group>
	)
}
