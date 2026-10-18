import { fade, type InkPalette } from "./appearance"
import { drawPlant, placer } from "./maple-scenery"
import type { Blob } from "./maple-scenery-field"
import { hash, type Prototypes, type Sketch } from "./maple-scenery-sketch"
import type { Vec3 } from "./types"

/** The meadow floor's height; terrain steps up from here. */
const BASE = -0.15

/** One terrace: a noisy outline extruded from y0 to y1, mossy top and shaded walls,
 * inked round both rims with a few vertical strokes on the walls the camera sees.
 * `side` picks each wall's colour from its outward direction. */
function terrace(
	sketch: Sketch,
	layer: Blob,
	y0: number,
	y1: number,
	top: string,
	side: (nx: number, nz: number) => string,
) {
	const ring = layer.outline
	ring.forEach(([ax, az], k) => {
		const [bx, bz] = ring[(k + 1) % ring.length] ?? [ax, az]
		// Fan wound so the top faces up; walls wound so they face outward.
		sketch.flat([layer.cx, y1, layer.cz, bx, y1, bz, ax, y1, az], top)
		const length = Math.hypot(bx - ax, bz - az) || 1
		const wall = side((bz - az) / length, -(bx - ax) / length)
		sketch.facets([ax, y0, az, ax, y1, az, bx, y0, bz, bx, y0, bz, ax, y1, az, bx, y1, bz], wall)
		sketch.lines([ax, y1, az, bx, y1, bz, ax, y0, az, bx, y0, bz])
		const facing = ax - layer.cx + (az - layer.cz) > layer.radius * 0.4
		if (k % 4 === 0 && facing) sketch.lines([ax, y0, az, ax, y1, az])
	})
}

/** The outcrop: stone faces where the steps crowd together, soil and moss where they
 * climb gently, rock ledges and boulders on the steps, trees, stair stones and a bench. */
export function drawHill(sketch: Sketch, stock: Prototypes, palette: InkPalette, hill: ReadonlyArray<Blob>) {
	const foot = hill[0],
		crown = hill.at(-1)
	if (!foot || !crown) return
	const heights = hill.map((_, i) => 0.34 + hash(i, foot.cx) * 0.14)
	const level = (i: number) => BASE + heights.slice(0, i).reduce((sum, h) => sum + h, 0)
	// The steep face is the side the upper steps crowd toward.
	const sx = crown.cx - foot.cx,
		sz = crown.cz - foot.cz
	const reach = Math.hypot(sx, sz) || 1
	const steepness = (nx: number, nz: number) => (nx * sx + nz * sz) / reach
	const moss = fade(palette.plinth, palette.evergreen, 0.35)
	hill.forEach((layer, i) =>
		terrace(sketch, layer, level(i), level(i + 1), moss, (nx, nz) =>
			steepness(nx, nz) > 0.1 || i > 1 ? palette.stone : palette.soil,
		),
	)
	hill.forEach((layer, i) => {
		const next = hill[i + 1]
		const y = level(i + 1)
		// Exposed ledges: rocks half sunk along each step's steep rim.
		layer.outline.forEach(([x, z], k) => {
			const [nx, nz] = [x - layer.cx, z - layer.cz]
			const n = Math.hypot(nx, nz) || 1
			if (k % 3 !== 0 || steepness(nx / n, nz / n) < 0.3) return
			const seed = hash(x, z + i)
			sketch.solid(stock.rock, {
				position: [x - (nx / n) * 0.12, y - 0.04, z - (nz / n) * 0.12],
				rotation: [0, seed * 6, 0],
				scale: [1 + seed * 0.6, 0.7, 0.9],
				color: palette.stone,
			})
		})
		// Open ground on this step: inside it, clear of the step above.
		const open = (angle: number, depth: number) => {
			const r = layer.radiusAt(angle) * depth
			const x = layer.cx + Math.cos(angle) * r,
				z = layer.cz + Math.sin(angle) * r
			return !next || next.rim(x, z) < -0.3 ? ([x, z] as const) : null
		}
		return drawStep(sketch, stock, palette, i, hill.length, y, open)
	})
	drawStair(sketch, stock, palette, hill, level, steepness)
}

/** A low mound in the meadow: one or two grassy steps tall enough to show a soil bank,
 * with a bush and a few tufts on top. */
export function drawMound(
	sketch: Sketch,
	stock: Prototypes,
	palette: InkPalette,
	layers: ReadonlyArray<Blob>,
) {
	const top = fade(palette.plinth, palette.evergreen, 0.15)
	const rise = 0.2
	layers.forEach((layer, i) =>
		terrace(sketch, layer, BASE + i * rise, BASE + (i + 1) * rise, top, () => palette.soil),
	)
	const crown = layers.at(-1)
	if (!crown) return
	const y = BASE + layers.length * rise
	const seed = hash(crown.cx, crown.cz)
	const bush = { kind: "bush", x: crown.cx, z: crown.cz, seed, size: 0.9, gap: 9 } as const
	drawPlant(sketch, stock, palette, bush, y)
	for (let k = 0; k < 3; k++) {
		const angle = seed * 6 + k * 2.1
		const r = crown.radiusAt(angle) * 0.6
		const grass = {
			kind: "grass" as const,
			x: crown.cx + Math.cos(angle) * r,
			z: crown.cz + Math.sin(angle) * r,
		}
		drawPlant(sketch, stock, palette, { ...grass, seed: hash(k, seed), size: 1, gap: 9 }, y)
	}
}

/** The lake: open water with an inked shore, reeds in clumps along it and a few lily pads. */
export function drawLake(sketch: Sketch, stock: Prototypes, palette: InkPalette, lake: Blob) {
	const y = BASE + 0.018
	lake.outline.forEach(([ax, az], k) => {
		const [bx, bz] = lake.outline[(k + 1) % lake.outline.length] ?? [ax, az]
		sketch.flat([lake.cx, y, lake.cz, bx, y, bz, ax, y, az], palette.water)
		sketch.lines([ax, y, az, bx, y, bz])
		if (hash(k, 7.7) < 0.8) return
		// A clump of reeds just inside the shore, cattail heads on two of them.
		const [rx, rz] = [ax + (lake.cx - ax) * 0.06, az + (lake.cz - az) * 0.06]
		const { part, stroke } = placer(sketch, [rx, y, rz], hash(ax, az) * 6)
		stroke([
			[0, 0, 0],
			[-0.04, 0.34, 0],
			[0.05, 0, 0.03],
			[0.07, 0.42, 0.03],
			[-0.05, 0, -0.04],
			[-0.1, 0.26, -0.06],
		])
		part(stock.box, [-0.035, 0.32, 0], [0.03, 0.08, 0.03], palette.trunk)
		part(stock.box, [0.068, 0.4, 0.03], [0.03, 0.08, 0.03], palette.trunk)
	})
	for (let i = 0; i < 5; i++) {
		const angle = hash(i, 1.1) * Math.PI * 2
		const r = lake.radiusAt(angle) * (0.35 + hash(1.3, i) * 0.4)
		const x = lake.cx + Math.cos(angle) * r,
			z = lake.cz + Math.sin(angle) * r
		sketch.solid(stock.log, {
			position: [x, y + 0.006, z],
			scale: [0.13, 0.012, 0.13],
			color: palette.evergreen,
		})
		if (i % 2 === 0)
			sketch.solid(stock.box, { position: [x + 0.04, y + 0.03, z], scale: 0.045, color: palette.birch })
	}
}

/** A small plank dock running from the shore out over the water along `yaw`. */
export function drawDock(sketch: Sketch, stock: Prototypes, palette: InkPalette, at: Vec3, yaw: number) {
	const { part } = placer(sketch, at, yaw)
	for (let i = 0; i < 6; i++) part(stock.box, [0, 0.12, -0.1 + i * 0.22], [0.56, 0.04, 0.19], palette.kraft)
	for (const x of [-0.25, 0.25])
		for (const z of [-0.1, 1.0]) part(stock.box, [x, 0.1, z], [0.06, 0.3, 0.06], palette.trunk)
}

/** A dirt footpath: a flat soil ribbon with a soft, broken ink edge. */
export function drawPath(
	sketch: Sketch,
	palette: InkPalette,
	points: ReadonlyArray<readonly [number, number]>,
) {
	const y = BASE + 0.006
	const edge = (i: number) => {
		const [x, z] = points[i] ?? [0, 0]
		const [ax, az] = points[Math.max(0, i - 1)] ?? [x, z],
			[bx, bz] = points[Math.min(points.length - 1, i + 1)] ?? [x, z]
		const length = Math.hypot(bx - ax, bz - az) || 1
		const [nx, nz] = [(bz - az) / length, -(bx - ax) / length]
		// Narrow at both ends, so the path tapers into the grass.
		const w = 0.17 * Math.min(1, i / 3, (points.length - 1 - i) / 3) + 0.03
		return { left: [x + nx * w, y, z + nz * w], right: [x - nx * w, y, z - nz * w] } as const
	}
	for (let i = 0; i + 1 < points.length; i++) {
		const a = edge(i),
			b = edge(i + 1)
		sketch.flat([...a.left, ...a.right, ...b.left, ...b.left, ...a.right, ...b.right], palette.soil)
		if (i % 2 === 0) sketch.lines([...a.left, ...b.left])
		if (i % 2 === 1) sketch.lines([...a.right, ...b.right])
	}
}

/** Trees and rocks on one step: maples low down, pines higher up, a lookout bench on top. */
function drawStep(
	sketch: Sketch,
	stock: Prototypes,
	palette: InkPalette,
	i: number,
	count: number,
	y: number,
	open: (angle: number, depth: number) => readonly [number, number] | null,
) {
	const spots = Array.from({ length: 12 }, (_, k) => open((k / 12) * Math.PI * 2 + i, 0.62))
		.filter((spot): spot is readonly [number, number] => spot !== null)
		.sort(([ax, az], [bx, bz]) => hash(ax, az) - hash(bx, bz))
		.filter(([x, z], k, all) => all.slice(0, k).every(([ox, oz]) => Math.hypot(x - ox, z - oz) > 0.8))
	const top = i === count - 1
	const trees = top ? 0 : i === 0 || i === count - 2 ? 2 : 1
	spots.slice(0, trees).forEach(([x, z], k) => {
		const kind = i === 0 ? "maple" : k % 2 === 0 ? "pine" : "spruce"
		drawPlant(
			sketch,
			stock,
			palette,
			{ kind, x, z, seed: hash(x, z), size: i === 0 ? 0.9 : 0.8, gap: 9 },
			y,
		)
	})
	const rock = spots[trees]
	if (rock && !top)
		sketch.solid(stock.rock, {
			position: [rock[0], y + 0.06, rock[1]],
			rotation: [0, hash(rock[0], 1) * 6, 0],
			scale: [1.2, 0.75, 1],
			color: palette.stone,
		})
	const seat = top ? open(Math.PI * 0.25, 0.15) : null
	if (!seat) return
	// A lookout bench on the summit, facing the clearing and the camera.
	const { part } = placer(sketch, [seat[0], y, seat[1]], Math.PI / 4)
	part(stock.box, [0, 0.17, 0], [0.5, 0.04, 0.15], palette.kraft)
	part(stock.box, [0, 0.28, -0.07], [0.5, 0.12, 0.03], palette.kraft)
	for (const x of [-0.2, 0.2]) part(stock.box, [x, 0.08, 0], [0.04, 0.16, 0.13], palette.trunk)
}

/** Stone stairs up the gentle flank, two blocks at each step's edge. */
function drawStair(
	sketch: Sketch,
	stock: Prototypes,
	palette: InkPalette,
	hill: ReadonlyArray<Blob>,
	level: (i: number) => number,
	steepness: (nx: number, nz: number) => number,
) {
	const gentle = Array.from({ length: 24 }, (_, k) => (k / 24) * Math.PI * 2).reduce((best, angle) =>
		steepness(Math.cos(angle), Math.sin(angle)) < steepness(Math.cos(best), Math.sin(best))
			? angle
			: best,
	)
	const [ox, oz] = [Math.cos(gentle), Math.sin(gentle)]
	hill.forEach((layer, i) => {
		const r = layer.radiusAt(gentle)
		const x = layer.cx + ox * r,
			z = layer.cz + oz * r
		const y0 = level(i),
			h = level(i + 1) - y0
		const { part } = placer(sketch, [x, y0, z], Math.atan2(ox, oz))
		part(stock.box, [0, h / 6, 0.28], [0.34, h / 3, 0.2], palette.stone)
		part(stock.box, [0, h / 3, 0.1], [0.34, (h * 2) / 3, 0.18], palette.stone)
	})
}
