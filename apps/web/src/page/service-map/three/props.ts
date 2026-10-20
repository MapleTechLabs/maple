import * as THREE from "three"
import { bunting } from "./decor"
import { type Child, group, inkBox, inkLines, inkPlate, inkSolid, type Scope, type Vec3 } from "./kit"
import { grain, inkParts, type MapleFinish, mapleSmoke, type Part, range, variant } from "./props-kit"

export { inkParts, type MachineFinish, type MapleFinish, type Part, seedOf, variant } from "./props-kit"
export { boardedWindow, doorSteps, flowerBox, mapleState, yard } from "./props-life"

/** A closed octagon round the y axis, aligned with the vats' turned facets. */
function octagon(radius: number, y: number) {
	const at = (k: number) => {
		const a = Math.PI / 8 + (k * Math.PI) / 4
		return [radius * Math.sin(a), y, radius * Math.cos(a)]
	}
	return range(8).flatMap((k) => [...at(k), ...at(k + 1)])
}

/** A low fieldstone footing round a cabin, joints staggered in two courses. */
export function stoneCourse(
	_scope: Scope,
	{ half, height, finish }: { half: number; height: number; finish: MapleFinish },
): Child {
	const edge = half + 0.03
	const face = edge + 0.001
	const joints = [0, 1].flatMap((row) =>
		range(6)
			.map((i) => -edge + 0.15 + row * 0.15 + i * 0.3)
			.filter((s) => s < edge - 0.06)
			.flatMap((s) => {
				const [y0, y1] = [(row * height) / 2, ((row + 1) * height) / 2]
				return [s, y0, face, s, y1, face, face, y0, s, face, y1, s]
			}),
	)
	const bed = [
		-edge,
		height / 2,
		face,
		face,
		height / 2,
		face,
		face,
		height / 2,
		face,
		face,
		height / 2,
		-edge,
	]
	return [
		inkBox({
			size: [edge * 2, height, edge * 2],
			position: [0, height / 2, 0],
			color: finish.stone,
			ink: finish.ink,
		}),
		inkLines([...joints, ...bed], finish.ink),
	]
}

/** A coursed stone stack with a capstone, a clay flue pot and wood smoke. */
export function stoneChimney(
	scope: Scope,
	{ base, height, width, finish }: { base: Vec3; height: number; width: number; finish: MapleFinish },
): THREE.Group {
	return group({ position: base }, [
		inkBox({
			size: [width, height, width],
			position: [0, height / 2, 0],
			color: finish.stone,
			ink: finish.ink,
			cell: 0.13,
		}),
		inkBox({
			size: [width + 0.08, 0.06, width + 0.08],
			position: [0, height + 0.03, 0],
			color: finish.stone,
			ink: finish.ink,
		}),
		inkBox({
			size: [width * 0.45, 0.1, width * 0.45],
			position: [0, height + 0.11, 0],
			color: finish.shingle,
			ink: finish.ink,
		}),
		mapleSmoke(scope, { position: [0, height + 0.24, 0], finish }),
	])
}

/** An iron stovepipe through the roof with a collar and a coolie-hat cap. */
export function stovepipe(
	scope: Scope,
	{ position, finish }: { position: Vec3; finish: MapleFinish },
): Child {
	const [x, y, z] = position
	const parts: Part[] = [
		{ prism: [0.08, 0.08, 0.04, 8], at: [x, y + 0.02, z] },
		{ prism: [0.045, 0.045, 0.42, 8], at: [x, y + 0.21, z] },
		{ prism: [0, 0.12, 0.07, 8], at: [x, y + 0.48, z] },
	]
	return inkParts(scope, { parts, color: finish.iron, ink: finish.ink })
}

/** A timber porch at an x-facing door: decking, a step, two posts and a shingled canopy. */
export function porch(scope: Scope, { door, finish }: { door: Vec3; finish: MapleFinish }): Child {
	const [x, y, z] = door
	const floor = y - 0.18
	const top = y + 0.32
	const lean = -0.32
	const [cx, cy] = [x + 0.13, top + 0.03]
	const timber: Part[] = [
		{ box: [0.24, floor - 0.004, 0.62], at: [x + 0.12, (floor - 0.004) / 2, z] },
		{ box: [0.08, floor / 2, 0.42], at: [x + 0.28, floor / 4, z] },
		...[-1, 1].map((side): Part => ({
			box: [0.05, top - floor, 0.05],
			at: [x + 0.22, (top + floor) / 2, z + side * 0.27],
		})),
	]
	// Shingle courses run across the canopy, drawn on its upper face.
	const courses = [-0.07, 0.04].flatMap((s) => {
		const px = cx + s * Math.cos(lean) - 0.019 * Math.sin(lean)
		const py = cy + s * Math.sin(lean) + 0.019 * Math.cos(lean)
		return [px, py, z - 0.36, px, py, z + 0.36]
	})
	const planks = [-0.15, 0, 0.15].flatMap((dz) => [
		x,
		floor - 0.003,
		z + dz,
		x + 0.24,
		floor - 0.003,
		z + dz,
	])
	return [
		inkParts(scope, { parts: timber, color: finish.timber, ink: finish.ink }),
		inkParts(scope, {
			parts: [{ box: [0.34, 0.035, 0.72], at: [cx, cy, z], turn: [0, 0, lean] }],
			color: finish.shingle,
			ink: finish.ink,
		}),
		inkLines([...courses, ...planks], finish.ink),
	]
}

export type Pane = { center: Vec3; normal: "x" | "z" }

/** Batten shutters either side of each window and a sill below, two batches for all of them. */
export function windowDressing(
	scope: Scope,
	{ windows, finish }: { windows: readonly Pane[]; finish: MapleFinish },
): Child {
	const shutters = windows.flatMap(({ center: [x, y, z], normal }) =>
		[-1, 1].map((side): Part =>
			normal === "z"
				? { box: [0.1, 0.28, 0.02], at: [x + side * 0.23, y, z + 0.01] }
				: { box: [0.02, 0.28, 0.1], at: [x + 0.01, y, z + side * 0.23] },
		),
	)
	const sills = windows.map(({ center: [x, y, z], normal }): Part =>
		normal === "z"
			? { box: [0.44, 0.035, 0.07], at: [x, y - 0.15, z + 0.03] }
			: { box: [0.07, 0.035, 0.44], at: [x + 0.03, y - 0.15, z] },
	)
	// A diagonal brace on each shutter, like a board-and-batten door.
	const braces = windows.flatMap(({ center: [x, y, z], normal }) =>
		[-1, 1].flatMap((side) =>
			normal === "z"
				? [x + side * 0.18, y - 0.1, z + 0.021, x + side * 0.28, y + 0.1, z + 0.021]
				: [x + 0.021, y - 0.1, z + side * 0.18, x + 0.021, y + 0.1, z + side * 0.28],
		),
	)
	return [
		inkParts(scope, { parts: shutters, color: finish.shutter, ink: finish.ink }),
		inkParts(scope, { parts: sills, color: finish.timber, ink: finish.ink }),
		braces.length > 0 && inkLines(braces, finish.ink),
	]
}

/** A shingled eave band round a flat cabin roof, standing proud of the walls. */
export function eaves(
	scope: Scope,
	{ half, top, finish }: { half: number; top: number; finish: MapleFinish },
): Child {
	const edge = half + 0.04
	const [depth, tall] = [0.1, 0.12]
	const y = top - 0.03
	const inner = edge * 2 - depth * 2
	const parts: Part[] = [
		{ box: [edge * 2, tall, depth], at: [0, y, edge - depth / 2] },
		{ box: [edge * 2, tall, depth], at: [0, y, -edge + depth / 2] },
		{ box: [depth, tall, inner], at: [edge - depth / 2, y, 0] },
		{ box: [depth, tall, inner], at: [-edge + depth / 2, y, 0] },
	]
	// One row of shingle butts on the two walls the camera sees.
	const face = edge + 0.001
	const low = y - tall / 2
	const ticks = range(Math.floor((edge * 2) / 0.12)).flatMap((i) => {
		const s = -edge + 0.06 + i * 0.12
		return [s, low, face, s, y, face, face, low, s, face, y, s]
	})
	const course = [-edge, y, face, face, y, face, face, y, face, face, y, -edge]
	return [
		inkParts(scope, { parts, color: finish.shingle, ink: finish.ink }),
		inkLines([...ticks, ...course], finish.ink),
	]
}

/** Iron hoops round an octagonal sugaring vat, standing a hair proud of the staves. */
export function vatHoops(
	scope: Scope,
	{ heights, finish }: { heights: readonly number[]; finish: MapleFinish },
): Child {
	const parts = heights.map((y): Part => ({
		prism: [0.85, 0.85, 0.07, 8],
		at: [0, y, 0],
		turn: [0, Math.PI / 8, 0],
	}))
	return [
		inkParts(scope, { parts, color: finish.iron, ink: finish.ink }),
		inkParts(scope, {
			parts: [{ prism: [0.9, 0.94, 0.1, 8], at: [0, 0.05, 0], turn: [0, Math.PI / 8, 0] }],
			color: finish.stone,
			ink: finish.ink,
		}),
	]
}

/** A shingled hip roof over the vat, flat on top for the service mark, with a steam cupola. */
export function sugarRoof(scope: Scope, { height, finish }: { height: number; finish: MapleFinish }): Child {
	const vent: Vec3 = [-0.46, height, -0.46]
	const courses = [1, 2].flatMap((i) => octagon(0.98 - (0.54 * i) / 3, height + (0.3 * i) / 3))
	return [
		inkParts(scope, {
			parts: [{ prism: [0.44, 0.98, 0.3, 8], at: [0, height + 0.15, 0], turn: [0, Math.PI / 8, 0] }],
			color: finish.shingle,
			ink: finish.ink,
		}),
		inkLines(courses, finish.ink),
		inkBox({
			size: [0.18, 0.34, 0.18],
			position: [vent[0], height + 0.27, vent[2]],
			color: finish.face,
			ink: finish.ink,
		}),
		inkLines(
			[vent[0] + 0.091, height + 0.36, vent[2] - 0.05, vent[0] + 0.091, height + 0.36, vent[2] + 0.05],
			finish.ink,
		),
		inkParts(scope, {
			parts: [
				{
					prism: [0, 0.17, 0.1, 4],
					at: [vent[0], height + 0.49, vent[2]],
					turn: [0, Math.PI / 4, 0],
				},
			],
			color: finish.shingle,
			ink: finish.ink,
		}),
		mapleSmoke(scope, { position: [vent[0], height + 0.6, vent[2]], finish }),
	]
}

/** A chopping block with an axe bitten into its top. */
export function choppingStump(
	scope: Scope,
	{ position, finish }: { position: Vec3; finish: MapleFinish },
): Child {
	const [x, y, z] = position
	const lean = -0.6
	const top = y + 0.2
	// The handle leans toward the camera's right from where the bit sinks in.
	const [hx, hy] = [x - Math.sin(lean) * 0.17, top + Math.cos(lean) * 0.17]
	return [
		inkParts(scope, {
			parts: [{ prism: [0.12, 0.135, 0.2, 8], at: [x, y + 0.1, z] }],
			color: finish.timber,
			ink: finish.ink,
		}),
		inkParts(scope, {
			parts: [{ prism: [0.11, 0.11, 0.012, 8], at: [x, top + 0.006, z] }],
			color: finish.kraft,
			ink: finish.ink,
		}),
		inkLines([...grainTop([x, top + 0.013, z], 0.06)], finish.ink),
		inkParts(scope, {
			parts: [{ box: [0.028, 0.3, 0.028], at: [hx, hy, z], turn: [0, 0, lean] }],
			color: finish.kraft,
			ink: finish.ink,
		}),
		inkParts(scope, {
			parts: [{ box: [0.13, 0.07, 0.025], at: [x - 0.01, top + 0.02, z], turn: [0, 0, lean] }],
			color: finish.iron,
			ink: finish.ink,
		}),
	]
}

/** A ring of end grain lying flat on a sawn top. */
function grainTop([x, y, z]: Vec3, radius: number) {
	const at = (k: number) => [
		x + radius * Math.sin((k * Math.PI) / 4),
		y,
		z + radius * Math.cos((k * Math.PI) / 4),
	]
	return range(8).flatMap((k) => [...at(k), ...at(k + 1)])
}

/** A wood sled on bent runners, loaded with three split logs. */
export function woodSled(scope: Scope, { position, finish }: { position: Vec3; finish: MapleFinish }): Child {
	const [x, y, z] = position
	const runners = [-0.12, 0.12].flatMap((dz): Part[] => [
		{ box: [0.6, 0.035, 0.03], at: [x, y + 0.018, z + dz] },
		{ box: [0.14, 0.03, 0.03], at: [x + 0.34, y + 0.06, z + dz], turn: [0, 0, 0.75] },
		{ box: [0.03, 0.05, 0.03], at: [x - 0.2, y + 0.06, z + dz] },
		{ box: [0.03, 0.05, 0.03], at: [x + 0.16, y + 0.06, z + dz] },
	])
	const deck = y + 0.095
	const logs: Part[] = (
		[
			[-0.075, 0],
			[0.075, 0],
			[0, 1],
		] as const
	).map(([dz, row]): Part => ({
		prism: [0.07, 0.07, 0.44, 8],
		at: [x - 0.02, deck + 0.085 + row * 0.12, z + dz],
		turn: [0, 0, Math.PI / 2],
	}))
	const ends = logs.flatMap((log) => grain([x + 0.201, log.at[1], log.at[2]], "x", 0.035))
	const slats = [-0.15, 0, 0.15].flatMap((dx) => [
		x + dx,
		deck + 0.016,
		z - 0.15,
		x + dx,
		deck + 0.016,
		z + 0.15,
	])
	return [
		inkParts(scope, { parts: runners, color: finish.timber, ink: finish.ink }),
		inkParts(scope, {
			parts: [{ box: [0.5, 0.03, 0.3], at: [x - 0.02, deck, z] }],
			color: finish.face,
			ink: finish.ink,
		}),
		inkParts(scope, { parts: logs, color: finish.kraft, ink: finish.ink }),
		inkLines([...slats, ...ends], finish.ink),
	]
}

/** A shingled gable roof, ridge along x, with board siding in the camera-facing gable end. */
export function gableRoof(
	_scope: Scope,
	{
		base,
		half,
		rise,
		length,
		color,
		finish,
	}: {
		base: number
		half: number
		rise: number
		length: number
		/** Defaults to the red shingle; light cedar shakes keep small roofs from reading as a barn. */
		color?: string
		finish: MapleFinish
	},
): Child {
	const gable = new THREE.Shape()
	gable.moveTo(-half, 0)
	gable.lineTo(half, 0)
	gable.lineTo(0, rise)
	gable.closePath()
	const geometry = new THREE.ExtrudeGeometry(gable, { depth: length, bevelEnabled: false })
	geometry.translate(0, 0, -length / 2)
	const courses = [1, 2].flatMap((i) => {
		const t = i / 3
		const [y, z] = [base + rise * t + 0.002, half * (1 - t) + 0.002]
		return [-length / 2, y, z, length / 2, y, z]
	})
	const end = length / 2 + 0.002
	const boards = [-0.5, -0.25, 0, 0.25, 0.5]
		.filter((z) => Math.abs(z) < half - 0.1)
		.flatMap((z) => [end, base, z, end, base + rise * (1 - Math.abs(z) / half), z])
	return [
		inkSolid({
			geometry,
			position: [0, base, 0],
			rotation: [0, Math.PI / 2, 0],
			color: color ?? finish.shingle,
			ink: finish.ink,
		}),
		inkLines([...courses, ...boards], finish.ink),
	]
}

/** An inn sign on a bracket arm, swinging from two short chains, a maple leaf painted on. */
export function hangingSign(
	scope: Scope,
	{
		position,
		board: cut = 0,
		finish,
	}: {
		position: Vec3
		/** 0 a wide board, 1 a tall board, 2 a round one. */
		board?: number
		finish: MapleFinish
	},
): Child {
	const [x, y, z] = position
	const hang = y - ([0.25, 0.29, 0.27][cut % 3] ?? 0.25)
	const sign: Part =
		cut % 3 === 2
			? { prism: [0.13, 0.13, 0.03, 8], at: [x + 0.01, hang, z], turn: [Math.PI / 2, 0, 0] }
			: { box: cut % 3 === 1 ? [0.2, 0.26, 0.03] : [0.3, 0.18, 0.03], at: [x + 0.01, hang, z] }
	// Each chain zigzags a little so it reads as links rather than a rod.
	const chain = (cx: number) =>
		range(4).flatMap((i) => {
			const [a, b] = [y - 0.02 - i * 0.035, y - 0.02 - (i + 1) * 0.035]
			const [za, zb] = [z + (i % 2 === 0 ? -0.012 : 0.012), z + (i % 2 === 0 ? 0.012 : -0.012)]
			return [cx, a, za, cx, b, zb]
		})
	return [
		inkParts(scope, {
			parts: [
				{ box: [0.36, 0.04, 0.04], at: [x, y, z] },
				{ box: [0.2, 0.04, 0.04], at: [x - 0.1, y - 0.07, z], turn: [0, 0, 0.8] },
			],
			color: finish.timber,
			ink: finish.ink,
		}),
		inkLines([...chain(x - 0.08), ...chain(x + 0.1)], finish.ink),
		inkParts(scope, { parts: [sign], color: finish.kraft, ink: finish.ink }),
		inkParts(scope, {
			parts: [{ box: [0.08, 0.08, 0.01], at: [x + 0.01, hang, z + 0.018], turn: [0, 0, Math.PI / 4] }],
			color: finish.gifts[0] ?? finish.signal,
			ink: finish.ink,
		}),
	]
}

/** Hewn log walls on the two visible faces, crossing at notched corners with end grain showing. */
export function logWalls(scope: Scope, { walls, finish }: { walls: number; finish: MapleFinish }): Child {
	const courses = (start: number) =>
		range(Math.floor((walls - 0.06 - start) / 0.14) + 1).map((i) => start + i * 0.14)
	const front = courses(0.06).map((y): Part => ({ box: [1.78, 0.12, 0.12], at: [0, y, 0.8] }))
	const side = courses(0.13).map((y): Part => ({ box: [0.12, 0.12, 1.78], at: [0.8, y, 0] }))
	const ends = [
		...front.flatMap((log) => grain([0.891, log.at[1], 0.8], "x", 0.04)),
		...side.flatMap((log) => grain([0.8, log.at[1], 0.891], "z", 0.04)),
	]
	return [
		inkParts(scope, { parts: [...front, ...side], color: finish.face, ink: finish.ink }),
		inkLines(ends, finish.ink),
	]
}

/** Height of the gate's header board centre above the post tops, where the service mark hangs. */
export const GATE_MARK = { y: 0.26, z: 0.497 } as const

/** An open timber gate: four posts on stone footings, braced beams, a header board for the
 * mark and health plates, and a light shake roof, so the passage stays see-through. */
export function mapleGate(scope: Scope, { posts, finish }: { posts: number; finish: MapleFinish }): Child {
	const top = posts + 0.56
	// Each gate strings its leaves in its own order and picks a sign shape.
	const turn = variant(finish.seed, 7, Math.max(1, finish.gifts.length))
	const garland = { ...finish, gifts: [...finish.gifts.slice(turn), ...finish.gifts.slice(0, turn)] }
	const corners = [-0.6, 0.6].flatMap((x) => [-0.45, 0.45].map((z) => [x, z] as const))
	const timber: Part[] = [
		...corners.map(([x, z]): Part => ({ box: [0.18, top - 0.14, 0.18], at: [x, (top + 0.14) / 2, z] })),
		{ box: [1.5, 0.08, 0.14], at: [0, posts, 0.45] },
		{ box: [1.5, 0.12, 0.14], at: [0, top - 0.06, -0.45] },
		...[-0.6, 0.6].map((x): Part => ({ box: [0.14, 0.12, 1.1], at: [x, top - 0.06, 0] })),
		// Knee braces from each post up into the lintels, front and back.
		...corners.map(([x, z]): Part => ({
			box: [0.22, 0.05, 0.05],
			at: [x > 0 ? 0.43 : -0.43, posts - 0.08, z],
			turn: [0, 0, x > 0 ? -Math.PI / 4 : Math.PI / 4],
		})),
	]
	const footings = corners.map(([x, z]): Part => ({ box: [0.28, 0.14, 0.28], at: [x, 0.07, z] }))
	return [
		inkParts(scope, { parts: footings, color: finish.stone, ink: finish.ink }),
		inkParts(scope, { parts: timber, color: finish.timber, ink: finish.ink }),
		inkBox({
			size: [1.3, 0.44, 0.06],
			position: [0, posts + GATE_MARK.y, 0.45],
			color: finish.face,
			ink: finish.ink,
		}),
		[-0.365, 0.365].map((x) =>
			inkPlate({
				size: [0.2, 0.3],
				position: [x, posts + GATE_MARK.y, 0.481],
				normal: "z",
				color: finish.signal,
				ink: finish.ink,
			}),
		),
		gableRoof(scope, { base: top, half: 0.56, rise: 0.28, length: 1.62, color: finish.kraft, finish }),
		bunting(scope, { from: [-0.5, posts - 0.05, 0.56], to: [0.5, posts - 0.05, 0.56], finish: garland }),
		hangingSign(scope, {
			position: [0.87, posts - 0.12, 0.45],
			board: variant(finish.seed, 8, 3),
			finish,
		}),
	]
}
