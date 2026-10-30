import type * as THREE from "three"
import { fade, type InkPalette } from "./appearance"
import type { Creek, Meadow } from "./maple-scenery-field"
import { hash, type Prototypes, type Sketch } from "./maple-scenery-sketch"
import type { Growth, Plant } from "./maple-scenery-plan"
import type { Vec3 } from "./types"

/** Places parts relative to an origin turned by `yaw`; extra rotation stays about y then z. */
export function placer(sketch: Sketch, [ox, oy, oz]: Vec3, yaw: number, scale = 1) {
	const cos = Math.cos(yaw),
		sin = Math.sin(yaw)
	const at = ([x, y, z]: Vec3): Vec3 => [
		ox + (x * cos + z * sin) * scale,
		oy + y * scale,
		oz + (-x * sin + z * cos) * scale,
	]
	const part = (
		geometry: THREE.BufferGeometry,
		offset: Vec3,
		size: Vec3 | number,
		color: string,
		[, ry, rz]: Vec3 = [0, 0, 0],
	) =>
		sketch.solid(geometry, {
			position: at(offset),
			rotation: [0, yaw + ry, rz],
			scale:
				typeof size === "number" ? size * scale : [size[0] * scale, size[1] * scale, size[2] * scale],
			color,
		})
	const stroke = (points: Vec3[]) => sketch.lines(points.flatMap((point) => at(point)))
	return { part, stroke }
}

const leaf = (palette: InkPalette, index: number) =>
	palette.foliage[Math.abs(Math.floor(index)) % Math.max(1, palette.foliage.length)] ?? palette.kraft

/** One tree or patch of undergrowth, sized and turned by its seed. */
export function drawPlant(
	sketch: Sketch,
	stock: Prototypes,
	palette: InkPalette,
	plant: Plant,
	floor: number,
) {
	const { kind, x, z, seed, size } = plant
	const hue = hash(x, z * 3) * 5
	const { part, stroke } = placer(
		sketch,
		[x, floor, z],
		kind === "birch" ? 0 : seed * 6,
		(0.85 + seed * 0.5) * size,
	)
	switch (kind) {
		case "maple":
			part(stock.box, [0, 0.24, 0], [0.11, 0.48, 0.11], palette.trunk)
			part(stock.crown, [0, 0.66, 0], 1, leaf(palette, hue))
			part(stock.crown, [0.04, 1.0, -0.02], 0.66, leaf(palette, hue + 1))
			if (seed > 0.6) part(stock.crown, [0.24, 0.62, 0.12], 0.5, leaf(palette, hue + 2))
			return
		case "birch":
			part(stock.box, [0, 0.5, 0], [0.08, 1.0, 0.08], palette.birch)
			// Short dark lenticels on the two walls the camera sees.
			for (const y of [0.22, 0.41, 0.58, 0.77]) {
				stroke([
					[-0.02, y, 0.041],
					[0.025, y, 0.041],
				])
				stroke([
					[0.041, y + 0.09, 0.02],
					[0.041, y + 0.09, -0.025],
				])
			}
			part(stock.crown, [0, 1.02, 0], 0.62, leaf(palette, 2))
			part(stock.crown, [0.12, 1.26, 0.04], 0.44, leaf(palette, seed > 0.5 ? 4 : 2))
			return
		case "pine":
		case "spruce": {
			const tiers = kind === "pine" ? [0.42, 0.35, 0.27, 0.18] : [0.36, 0.25]
			part(stock.box, [0, 0.15, 0], [0.1, 0.3, 0.1], palette.trunk)
			tiers.forEach((radius, i) =>
				part(stock.tier, [0, 0.48 + i * 0.26, 0], [radius, 0.46, radius], palette.evergreen),
			)
			return
		}
		case "sapling":
			stroke([
				[0, 0, 0],
				[0, 0.34, 0],
				[0, 0.22, 0],
				[0.08, 0.3, 0],
			])
			part(stock.bud, [0, 0.4, 0], 0.55, leaf(palette, hue))
			part(stock.bud, [0.09, 0.32, 0], 0.32, leaf(palette, hue + 1))
			return
		case "stump":
			part(stock.log, [0, 0.08, 0], [0.14, 0.16, 0.14], palette.trunk)
			stroke(ring(0.07, 0.161, 7))
			return
		default:
			return drawUndergrowth(part, stroke, stock, palette, kind, seed)
	}
}

/** A closed polygon on the ground plane around the local origin, as stroke pairs. */
function ring(radius: number, y: number, sides: number): Vec3[] {
	return Array.from({ length: sides }, (_, i): Vec3[] => {
		const a = (i * Math.PI * 2) / sides,
			b = ((i + 1) * Math.PI * 2) / sides
		return [
			[radius * Math.sin(a), y, radius * Math.cos(a)],
			[radius * Math.sin(b), y, radius * Math.cos(b)],
		]
	}).flat()
}

type Placer = ReturnType<typeof placer>

function drawUndergrowth(
	part: Placer["part"],
	stroke: Placer["stroke"],
	stock: Prototypes,
	palette: InkPalette,
	kind: Growth,
	seed: number,
) {
	switch (kind) {
		case "rock":
			part(stock.rock, [0, 0.09, 0], [1.3, 0.65, 1], palette.stone)
			if (seed > 0.12) part(stock.rock, [0.3, 0.05, 0.12], [0.6, 0.4, 0.55], palette.stone)
			return
		case "bush":
			part(
				stock.crown,
				[0, 0.12, 0],
				[0.6, 0.42, 0.6],
				seed > 0.15 ? palette.evergreen : leaf(palette, 3),
			)
			part(stock.crown, [0.2, 0.08, 0.1], [0.38, 0.3, 0.38], palette.evergreen)
			return
		case "log":
			part(stock.log, [0, 0.1, 0], [0.1, 0.95, 0.1], palette.trunk, [0, 0, Math.PI / 2])
			// A sprig of moss and a shelf fungus on the bark.
			part(stock.cap, [0.18, 0.2, 0.04], [0.06, 0.04, 0.06], leaf(palette, 2))
			stroke([
				[0.48, 0.1, 0],
				[0.48, 0.16, 0.05],
			])
			return
		case "mushrooms":
			;[
				[0, 0, 1],
				[0.14, 0.08, 0.7],
				[-0.06, 0.16, 0.55],
			].forEach(([dx = 0, dz = 0, size = 1]) => {
				part(stock.box, [dx, 0.05 * size, dz], [0.04 * size, 0.1 * size, 0.04 * size], palette.birch)
				part(
					stock.cap,
					[dx, 0.12 * size, dz],
					[0.08 * size, 0.06 * size, 0.08 * size],
					leaf(palette, 0),
				)
			})
			return
		case "grass":
			stroke(tuft(0, 0))
			stroke(tuft(0.16, 0.08))
			return
		default:
			return
	}
}

/** Three blades of grass fanning from one root, as stroke pairs. */
function tuft(x: number, z: number): Vec3[] {
	return [
		[x, 0, z],
		[x - 0.06, 0.13, z],
		[x, 0, z],
		[x + 0.01, 0.17, z],
		[x, 0, z],
		[x + 0.07, 0.12, z],
	]
}

/** A flat water ribbon with inked banks and a few stones along its edge. */
export function drawCreek(
	sketch: Sketch,
	stock: Prototypes,
	palette: InkPalette,
	creek: Creek,
	floor: number,
	/** Stretches hidden under other water, such as the lake it flows out of. */
	submerged: (x: number, z: number) => boolean = () => false,
) {
	const y = floor + 0.005
	const steps = creek.samples.length - 1
	// "left" is the outer bank, "right" the clearing side; the winding keeps faces up.
	const edge = (i: number) => {
		const { x, z, nx, nz, w } = creek.samples[i] ?? creek.at(0)
		return { left: [x + nx * w, y, z + nz * w], right: [x - nx * w, y, z - nz * w], nx, nz } as const
	}
	for (let i = 0; i < steps; i++) {
		const a = edge(i),
			b = edge(i + 1)
		const head = creek.samples[i + 1]
		if (head && submerged(head.x, head.z)) continue
		sketch.flat([...a.left, ...a.right, ...b.left, ...b.left, ...a.right, ...b.right], palette.water)
		sketch.lines([...a.left, ...b.left, ...a.right, ...b.right])
		const seed = hash(i * 0.37, 5.1)
		if (seed > 0.8) {
			const bank = seed > 0.9 ? a.left : a.right
			const out = seed > 0.9 ? 0.08 : -0.08
			sketch.solid(stock.rock, {
				position: [bank[0] + a.nx * out, floor + 0.04, bank[2] + a.nz * out],
				rotation: [0, seed * 9, 0],
				scale: [0.7, 0.4, 0.6],
				color: palette.stone,
			})
		}
	}
}

/** A plank footbridge spanning the creek along `yaw`, rails on posts. */
export function drawBridge(sketch: Sketch, stock: Prototypes, palette: InkPalette, at: Vec3, yaw: number) {
	const { part } = placer(sketch, at, yaw)
	for (let i = 0; i < 6; i++) {
		const z = -0.55 + i * 0.22
		part(stock.box, [0, 0.1 + Math.cos(z * 1.6) * 0.06, z], [0.6, 0.04, 0.18], palette.kraft)
	}
	for (const x of [-0.29, 0.29]) {
		for (const z of [-0.55, 0.55]) part(stock.box, [x, 0.2, z], [0.05, 0.36, 0.05], palette.trunk)
		part(stock.box, [x, 0.36, 0], [0.035, 0.035, 1.12], palette.trunk)
	}
}

/** A zigzag split-rail fence between two ground points. */
export function drawFence(
	sketch: Sketch,
	stock: Prototypes,
	palette: InkPalette,
	fence: { from: readonly [number, number]; to: readonly [number, number] },
	floor: number,
) {
	const [ax, az] = fence.from,
		[bx, bz] = fence.to
	const length = Math.hypot(bx - ax, bz - az) || 1
	const [px, pz] = [-(bz - az) / length, (bx - ax) / length]
	const count = Math.max(2, Math.round(length / 0.6))
	const posts = Array.from({ length: count + 1 }, (_, i): Vec3 => {
		const t = i / count,
			zig = i % 2 === 0 ? -0.12 : 0.12
		return [ax + (bx - ax) * t + px * zig, floor, az + (bz - az) * t + pz * zig]
	})
	posts.forEach(([x, , z], i) => {
		sketch.solid(stock.box, {
			position: [x, floor + 0.23, z],
			scale: [0.06, 0.46, 0.06],
			color: palette.trunk,
		})
		const next = posts[i + 1]
		if (!next) return
		const dx = next[0] - x,
			dz = next[2] - z
		for (const h of [0.18, 0.36])
			sketch.solid(stock.box, {
				position: [x + dx / 2, floor + h, z + dz / 2],
				rotation: [0, Math.atan2(dx, dz), 0],
				scale: [0.04, 0.05, Math.hypot(dx, dz) + 0.08],
				color: palette.kraft,
			})
	})
}

/** A deer in profile by the water, head up. */
export function drawDeer(sketch: Sketch, stock: Prototypes, palette: InkPalette, at: Vec3) {
	const { part } = placer(sketch, at, DEER_YAW)
	part(stock.box, [0, 0.42, 0], [0.44, 0.17, 0.15], palette.soil)
	for (const [x, z] of [
		[-0.17, -0.05],
		[-0.17, 0.05],
		[0.16, -0.05],
		[0.16, 0.05],
	] as const)
		part(stock.box, [x, 0.17, z], [0.04, 0.34, 0.04], palette.soil)
	part(stock.box, [-0.23, 0.47, 0], [0.05, 0.06, 0.05], palette.birch)
}

/** The deer's neck pivot in its body frame, and the body's turn. */
export const DEER_YAW = -0.35
export const DEER_NECK: Vec3 = [0.22, 0.47, 0]

/** Neck, head and antlers around the neck pivot, so the head can turn while grazing. */
export function drawDeerHead(sketch: Sketch, stock: Prototypes, palette: InkPalette) {
	const { part, stroke } = placer(sketch, [0, 0, 0], 0)
	part(stock.box, [0, 0.1, 0], [0.08, 0.2, 0.08], palette.soil)
	part(stock.box, [0.06, 0.22, 0], [0.15, 0.08, 0.08], palette.soil)
	stroke([
		[0.03, 0.26, 0],
		[-0.02, 0.41, 0],
		[-0.02, 0.41, 0],
		[-0.09, 0.46, 0],
		[-0.02, 0.41, 0],
		[0.03, 0.48, 0],
		[0, 0.26, 0.03],
		[-0.05, 0.31, 0.07],
	])
}

/** A fox curled at the fence end, brush tipped white. */
export function drawFox(sketch: Sketch, stock: Prototypes, palette: InkPalette, at: Vec3) {
	const { part } = placer(sketch, at, 0.6)
	const coat = leaf(palette, 1)
	part(stock.box, [0, 0.14, 0], [0.3, 0.12, 0.11], coat)
	for (const x of [-0.11, 0.11]) part(stock.box, [x, 0.04, 0.03], [0.03, 0.08, 0.03], palette.iron)
	part(stock.box, [0.18, 0.22, 0], [0.11, 0.1, 0.1], coat)
	part(stock.box, [0.26, 0.2, 0], [0.06, 0.04, 0.05], palette.birch)
	for (const z of [-0.03, 0.03]) part(stock.tier, [0.17, 0.3, z], [0.025, 0.07, 0.025], coat)
	part(stock.tier, [-0.27, 0.14, 0.02], [0.06, 0.24, 0.06], coat, [0, 0, Math.PI / 2])
	part(stock.box, [-0.4, 0.14, 0.02], [0.04, 0.04, 0.04], palette.birch)
}

/** A bare snag with a crooked branch, three songbirds on it. */
export function drawPerch(sketch: Sketch, stock: Prototypes, palette: InkPalette, at: Vec3) {
	const { part, stroke } = placer(sketch, at, 0)
	part(stock.box, [0, 0.55, 0], [0.12, 1.1, 0.12], palette.trunk)
	part(stock.box, [0.27, 0.86, 0], [0.5, 0.04, 0.04], palette.trunk)
	stroke([
		[0, 1.1, 0],
		[-0.16, 1.32, 0],
		[0, 1.0, 0],
		[0.12, 1.24, -0.04],
		[0, 0.7, 0],
		[-0.2, 0.88, 0.04],
		[0.5, 0.86, 0],
		[0.6, 0.96, 0],
	])
	;[0.14, 0.3, 0.44].forEach((x, i) => {
		const color = i === 1 ? palette.iron : leaf(palette, 0)
		part(stock.box, [x, 0.92, 0], [0.09, 0.07, 0.06], color)
		part(stock.box, [x + 0.05, 0.97, 0], [0.045, 0.045, 0.045], color)
		stroke([
			[x - 0.045, 0.92, 0],
			[x - 0.09, 0.95, 0],
		])
	})
}

/** A ring of stones round crossed logs and a still flame, with two log seats. */
export function drawCampfire(sketch: Sketch, stock: Prototypes, palette: InkPalette, at: Vec3) {
	const { part } = placer(sketch, at, 0.3)
	for (let i = 0; i < 8; i++) {
		const angle = (i * Math.PI) / 4
		part(
			stock.rock,
			[Math.cos(angle) * 0.3, 0.04, Math.sin(angle) * 0.3],
			[0.45, 0.32, 0.4],
			palette.stone,
			[0, angle, 0],
		)
	}
	for (const turn of [Math.PI / 4, -Math.PI / 4])
		part(stock.log, [0, 0.06, 0], [0.045, 0.46, 0.045], palette.trunk, [0, turn, Math.PI / 2])
	part(stock.tier, [0, 0.18, 0], [0.11, 0.24, 0.11], leaf(palette, 1))
	part(stock.tier, [0.02, 0.16, 0.02], [0.06, 0.16, 0.06], palette.glow)
	for (const [x, z, turn] of [
		[-0.75, 0.1, 0.2],
		[0.15, 0.78, Math.PI / 2 - 0.15],
	] as const)
		part(stock.log, [x, 0.09, z], [0.09, 0.62, 0.09], palette.trunk, [0, turn, Math.PI / 2])
}

/** A paddling mallard facing +x: buff body, green head, gold bill. */
export function drawDuck(sketch: Sketch, stock: Prototypes, palette: InkPalette) {
	const { part } = placer(sketch, [0, 0, 0], 0)
	part(stock.box, [0, 0.05, 0], [0.2, 0.08, 0.11], palette.birch)
	part(stock.box, [-0.11, 0.08, 0], [0.05, 0.04, 0.06], palette.soil)
	part(stock.box, [0.09, 0.13, 0], [0.07, 0.08, 0.07], palette.evergreen)
	part(stock.box, [0.15, 0.12, 0], [0.05, 0.025, 0.04], leaf(palette, 2))
}

/** A gliding bird: two swept wings with a little dihedral, built at the origin facing +x. */
export function drawBird(sketch: Sketch, stock: Prototypes, color: string) {
	for (const side of [-1, 1])
		sketch.solid(stock.box, {
			position: [-0.03, 0.02, side * 0.09],
			rotation: [side * -0.35, side * -0.5, 0],
			scale: [0.05, 0.012, 0.19],
			color,
		})
	sketch.solid(stock.box, { position: [0, 0, 0], scale: [0.12, 0.03, 0.035], color })
}

/** A Maple blimp: a faceted envelope with tapered ends, a red band, tail fins and a gondola,
 * built at the origin facing +x. */
export function drawBlimp(sketch: Sketch, stock: Prototypes, palette: InkPalette) {
	const red = palette.gifts[0] ?? palette.selected
	const across: Vec3 = [0, 0, -Math.PI / 2]
	sketch.solid(stock.log, {
		position: [0, 0, 0],
		rotation: across,
		scale: [0.32, 1, 0.32],
		color: palette.birch,
	})
	sketch.solid(stock.log, {
		position: [0.1, 0, 0],
		rotation: across,
		scale: [0.325, 0.14, 0.325],
		color: red,
	})
	sketch.solid(stock.cap, {
		position: [0.7, 0, 0],
		rotation: across,
		scale: [0.32, 0.4, 0.32],
		color: palette.birch,
	})
	sketch.solid(stock.cap, {
		position: [-0.75, 0, 0],
		rotation: [0, 0, Math.PI / 2],
		scale: [0.32, 0.5, 0.32],
		color: palette.birch,
	})
	sketch.solid(stock.box, { position: [-0.82, 0.24, 0], scale: [0.26, 0.28, 0.03], color: red })
	sketch.solid(stock.box, { position: [-0.82, 0, 0], scale: [0.26, 0.03, 0.72], color: red })
	sketch.solid(stock.box, { position: [0.05, -0.37, 0], scale: [0.36, 0.1, 0.13], color: palette.soil })
}

/** The meadow floor: one flat blob under every zone with an inked edge, grass tufts and
 * a few flowers along its border. The paper only shows past this natural edge. */
export function drawMeadow(
	sketch: Sketch,
	stock: Prototypes,
	palette: InkPalette,
	meadow: Meadow,
	keep: (x: number, z: number) => boolean,
) {
	const y = -0.15
	const grass = fade(palette.plinth, palette.paper, 0.4)
	const rimAt = (k: number): Vec3 => {
		const [x, z] = meadow.point((k / meadow.count) * Math.PI * 2)
		return [x, y, z]
	}
	for (let k = 0; k < meadow.count; k++) {
		const a = rimAt(k),
			b = rimAt(k + 1)
		// Fan from the centre, wound so the faces look up at the camera.
		sketch.flat([meadow.cx, y, meadow.cz, ...b, ...a], grass)
		sketch.lines([...a, ...b])
	}
	for (let i = 0; i < 150; i++) {
		const theta = hash(i, 0.5) * Math.PI * 2
		const [x, z] = meadow.point(theta, 0.2 + hash(0.7, i) * 1.8)
		if (!keep(x, z)) continue
		const { part, stroke } = placer(sketch, [x, -0.14, z], hash(i, i) * 6)
		if (i % 5 === 0) {
			stroke([
				[0, 0, 0],
				[0, 0.1, 0],
			])
			part(stock.box, [0, 0.11, 0], 0.05, leaf(palette, i))
		} else stroke(tuft(0, 0))
	}
}

/** Flat stepping stones across the creek, a quieter crossing than the bridge. */
export function drawSteppingStones(
	sketch: Sketch,
	stock: Prototypes,
	palette: InkPalette,
	creek: Creek,
	floor: number,
) {
	const { x, z, nx, nz, w } = creek.at(creek.length * 0.72)
	;[-0.75, -0.25, 0.25, 0.75].forEach((t, i) =>
		sketch.solid(stock.rock, {
			position: [x + nx * w * t * 1.15, floor + 0.03, z + nz * w * t * 1.15],
			rotation: [0, hash(i, x) * 6, 0],
			scale: [0.75, 0.3, 0.65],
			color: palette.stone,
		}),
	)
}
