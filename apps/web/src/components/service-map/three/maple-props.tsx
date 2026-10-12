import { useRef, useState } from "react"
import { useFrame } from "@react-three/fiber"
import * as THREE from "three"
import { useMountEffect } from "@/hooks/use-mount-effect"
import type { MachineFinish, MachineKind } from "./appearance"
import {
	InkBox,
	InkLines,
	InkOutline,
	InkPlate,
	InkSolid,
	PaperMaterial,
	shadeFaces,
} from "./factory-primitives"
import { Bunting } from "./factory-decor"
import type { Vec3 } from "./types"

/** Colours the shared finish does not carry, resolved and faded like the rest. */
export type MapleFinish = MachineFinish & {
	stone: string
	iron: string
	glow: string
	timber: string
	shingle: string
	shutter: string
	/** Request volume in [0, 1]; 0 means idle, so chimneys go cold. */
	activity: number
	/** Error-rate health: elevated brings a worker, degraded darkens lamps and flies a flag. */
	trouble: "healthy" | "elevated" | "degraded"
	/** Stable per-node hash, so each homestead keeps its own roof, yard and quirks. */
	seed: number
	soil: string
	water: string
	moss: string
}

/** FNV-1a over a node id: the same service always draws the same homestead. */
export function seedOf(id: string) {
	return (
		Array.from(id).reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619), 2166136261) >>>
		0
	)
}

/** A deterministic choice in [0, n) for one named trait of a seeded machine. */
export function variant(seed: number, salt: number, n: number) {
	const mixed = Math.imul(seed ^ Math.imul(salt + 1, 0x9e3779b1), 0x85ebca6b)
	return ((mixed ^ (mixed >>> 15)) >>> 0) % n
}

/** One solid in a merged batch: a box or an n-sided prism, placed and turned. */
export type Part =
	| { box: readonly [number, number, number]; at: Vec3; turn?: Vec3 }
	| { prism: readonly [number, number, number, number]; at: Vec3; turn?: Vec3 }

function partGeometry(part: Part) {
	const base =
		"box" in part ? new THREE.BoxGeometry(...part.box) : new THREE.CylinderGeometry(...part.prism)
	const solid = base.toNonIndexed()
	base.dispose()
	const [rx, ry, rz] = part.turn ?? [0, 0, 0]
	solid.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)))
	solid.translate(...part.at)
	// Flat facet normals after the turn, so face tones follow the world-facing side.
	solid.computeVertexNormals()
	return solid
}

function mergeParts(parts: readonly Part[]) {
	const solids = parts.map(partGeometry)
	const join = (name: string) =>
		new THREE.Float32BufferAttribute(
			solids.flatMap((solid) => Array.from(solid.getAttribute(name).array)),
			3,
		)
	const merged = new THREE.BufferGeometry()
	merged.setAttribute("position", join("position"))
	merged.setAttribute("normal", join("normal"))
	solids.forEach((solid) => solid.dispose())
	return shadeFaces(merged)
}

/** Many solids in one mesh and one ink draw: hoops, shingles, logs, shutters. */
export function InkParts({ parts, color, ink }: { parts: readonly Part[]; color: string; ink: string }) {
	if (parts.length === 0) return null
	return <MergedParts key={JSON.stringify(parts)} parts={parts} color={color} ink={ink} />
}

function MergedParts({ parts, color, ink }: { parts: readonly Part[]; color: string; ink: string }) {
	const [batch] = useState(() => {
		const faces = mergeParts(parts)
		return { faces, lines: new THREE.EdgesGeometry(faces, 20) }
	})
	useMountEffect(() => () => {
		batch.faces.dispose()
		batch.lines.dispose()
	})
	return (
		<group>
			<mesh geometry={batch.faces}>
				<PaperMaterial color={color} />
			</mesh>
			<InkOutline geometry={batch.lines} ink={ink} />
		</group>
	)
}

const range = (count: number) => Array.from({ length: Math.max(0, count) }, (_, i) => i)

/** An octagon of end grain on an x- or z-facing cut. */
export function grain([x, y, z]: Vec3, normal: "x" | "z", radius: number) {
	const at = (k: number) => {
		const u = radius * Math.cos((k * Math.PI) / 4),
			v = radius * Math.sin((k * Math.PI) / 4)
		return normal === "x" ? [x, y + v, z + u] : [x + u, y + v, z]
	}
	return range(8).flatMap((k) => [...at(k), ...at(k + 1)])
}

/** A closed octagon round the y axis, aligned with the vats' turned facets. */
function octagon(radius: number, y: number) {
	const at = (k: number) => {
		const a = Math.PI / 8 + (k * Math.PI) / 4
		return [radius * Math.sin(a), y, radius * Math.cos(a)]
	}
	return range(8).flatMap((k) => [...at(k), ...at(k + 1)])
}

/** A low fieldstone footing round a cabin, joints staggered in two courses. */
export function StoneCourse({ half, height, finish }: { half: number; height: number; finish: MapleFinish }) {
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
	return (
		<>
			<InkBox
				size={[edge * 2, height, edge * 2]}
				position={[0, height / 2, 0]}
				color={finish.stone}
				ink={finish.ink}
			/>
			<InkLines points={[...joints, ...bed]} ink={finish.ink} />
		</>
	)
}

/** A coursed stone stack with a capstone, a clay flue pot and wood smoke. */
export function StoneChimney({
	base,
	height,
	width,
	finish,
}: {
	base: Vec3
	height: number
	width: number
	finish: MapleFinish
}) {
	return (
		<group position={[...base]}>
			<InkBox
				size={[width, height, width]}
				position={[0, height / 2, 0]}
				color={finish.stone}
				ink={finish.ink}
				cell={0.13}
			/>
			<InkBox
				size={[width + 0.08, 0.06, width + 0.08]}
				position={[0, height + 0.03, 0]}
				color={finish.stone}
				ink={finish.ink}
			/>
			<InkBox
				size={[width * 0.45, 0.1, width * 0.45]}
				position={[0, height + 0.11, 0]}
				color={finish.shingle}
				ink={finish.ink}
			/>
			<MapleSmoke position={[0, height + 0.24, 0]} finish={finish} />
		</group>
	)
}

/** An iron stovepipe through the roof with a collar and a coolie-hat cap. */
export function Stovepipe({ position, finish }: { position: Vec3; finish: MapleFinish }) {
	const [x, y, z] = position
	const parts: Part[] = [
		{ prism: [0.08, 0.08, 0.04, 8], at: [x, y + 0.02, z] },
		{ prism: [0.045, 0.045, 0.42, 8], at: [x, y + 0.21, z] },
		{ prism: [0, 0.12, 0.07, 8], at: [x, y + 0.48, z] },
	]
	return <InkParts parts={parts} color={finish.iron} ink={finish.ink} />
}

/** A timber porch at an x-facing door: decking, a step, two posts and a shingled canopy. */
export function Porch({ door, finish }: { door: Vec3; finish: MapleFinish }) {
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
	return (
		<>
			<InkParts parts={timber} color={finish.timber} ink={finish.ink} />
			<InkParts
				parts={[{ box: [0.34, 0.035, 0.72], at: [cx, cy, z], turn: [0, 0, lean] }]}
				color={finish.shingle}
				ink={finish.ink}
			/>
			<InkLines points={[...courses, ...planks]} ink={finish.ink} />
		</>
	)
}

export type Pane = { center: Vec3; normal: "x" | "z" }

/** Batten shutters either side of each window and a sill below, two batches for all of them. */
export function WindowDressing({ windows, finish }: { windows: readonly Pane[]; finish: MapleFinish }) {
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
	return (
		<>
			<InkParts parts={shutters} color={finish.shutter} ink={finish.ink} />
			<InkParts parts={sills} color={finish.timber} ink={finish.ink} />
			{braces.length > 0 && <InkLines points={braces} ink={finish.ink} />}
		</>
	)
}

/** A shingled eave band round a flat cabin roof, standing proud of the walls. */
export function Eaves({ half, top, finish }: { half: number; top: number; finish: MapleFinish }) {
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
	return (
		<>
			<InkParts parts={parts} color={finish.shingle} ink={finish.ink} />
			<InkLines points={[...ticks, ...course]} ink={finish.ink} />
		</>
	)
}

/** Iron hoops round an octagonal sugaring vat, standing a hair proud of the staves. */
export function VatHoops({ heights, finish }: { heights: readonly number[]; finish: MapleFinish }) {
	const parts = heights.map((y): Part => ({
		prism: [0.85, 0.85, 0.07, 8],
		at: [0, y, 0],
		turn: [0, Math.PI / 8, 0],
	}))
	return (
		<>
			<InkParts parts={parts} color={finish.iron} ink={finish.ink} />
			<InkParts
				parts={[{ prism: [0.9, 0.94, 0.1, 8], at: [0, 0.05, 0], turn: [0, Math.PI / 8, 0] }]}
				color={finish.stone}
				ink={finish.ink}
			/>
		</>
	)
}

/** A shingled hip roof over the vat, flat on top for the service mark, with a steam cupola. */
export function SugarRoof({ height, finish }: { height: number; finish: MapleFinish }) {
	const vent: Vec3 = [-0.46, height, -0.46]
	const courses = [1, 2].flatMap((i) => octagon(0.98 - (0.54 * i) / 3, height + (0.3 * i) / 3))
	return (
		<>
			<InkParts
				parts={[
					{ prism: [0.44, 0.98, 0.3, 8], at: [0, height + 0.15, 0], turn: [0, Math.PI / 8, 0] },
				]}
				color={finish.shingle}
				ink={finish.ink}
			/>
			<InkLines points={courses} ink={finish.ink} />
			<InkBox
				size={[0.18, 0.34, 0.18]}
				position={[vent[0], height + 0.27, vent[2]]}
				color={finish.face}
				ink={finish.ink}
			/>
			<InkLines
				points={[
					vent[0] + 0.091,
					height + 0.36,
					vent[2] - 0.05,
					vent[0] + 0.091,
					height + 0.36,
					vent[2] + 0.05,
				]}
				ink={finish.ink}
			/>
			<InkParts
				parts={[
					{
						prism: [0, 0.17, 0.1, 4],
						at: [vent[0], height + 0.49, vent[2]],
						turn: [0, Math.PI / 4, 0],
					},
				]}
				color={finish.shingle}
				ink={finish.ink}
			/>
			<MapleSmoke position={[vent[0], height + 0.6, vent[2]]} finish={finish} />
		</>
	)
}

/** A chopping block with an axe bitten into its top. */
export function ChoppingStump({ position, finish }: { position: Vec3; finish: MapleFinish }) {
	const [x, y, z] = position
	const lean = -0.6
	const top = y + 0.2
	// The handle leans toward the camera's right from where the bit sinks in.
	const [hx, hy] = [x - Math.sin(lean) * 0.17, top + Math.cos(lean) * 0.17]
	return (
		<>
			<InkParts
				parts={[{ prism: [0.12, 0.135, 0.2, 8], at: [x, y + 0.1, z] }]}
				color={finish.timber}
				ink={finish.ink}
			/>
			<InkParts
				parts={[{ prism: [0.11, 0.11, 0.012, 8], at: [x, top + 0.006, z] }]}
				color={finish.kraft}
				ink={finish.ink}
			/>
			<InkLines points={[...grainTop([x, top + 0.013, z], 0.06)]} ink={finish.ink} />
			<InkParts
				parts={[{ box: [0.028, 0.3, 0.028], at: [hx, hy, z], turn: [0, 0, lean] }]}
				color={finish.kraft}
				ink={finish.ink}
			/>
			<InkParts
				parts={[{ box: [0.13, 0.07, 0.025], at: [x - 0.01, top + 0.02, z], turn: [0, 0, lean] }]}
				color={finish.iron}
				ink={finish.ink}
			/>
		</>
	)
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
export function WoodSled({ position, finish }: { position: Vec3; finish: MapleFinish }) {
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
	return (
		<>
			<InkParts parts={runners} color={finish.timber} ink={finish.ink} />
			<InkParts
				parts={[{ box: [0.5, 0.03, 0.3], at: [x - 0.02, deck, z] }]}
				color={finish.face}
				ink={finish.ink}
			/>
			<InkParts parts={logs} color={finish.kraft} ink={finish.ink} />
			<InkLines points={[...slats, ...ends]} ink={finish.ink} />
		</>
	)
}

/** A shingled gable roof, ridge along x, with board siding in the camera-facing gable end. */
export function GableRoof({
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
}) {
	const [geometry] = useState(() => {
		const gable = new THREE.Shape()
		gable.moveTo(-half, 0)
		gable.lineTo(half, 0)
		gable.lineTo(0, rise)
		gable.closePath()
		const solid = new THREE.ExtrudeGeometry(gable, { depth: length, bevelEnabled: false })
		solid.translate(0, 0, -length / 2)
		return solid
	})
	const courses = [1, 2].flatMap((i) => {
		const t = i / 3
		const [y, z] = [base + rise * t + 0.002, half * (1 - t) + 0.002]
		return [-length / 2, y, z, length / 2, y, z]
	})
	const end = length / 2 + 0.002
	const boards = [-0.5, -0.25, 0, 0.25, 0.5]
		.filter((z) => Math.abs(z) < half - 0.1)
		.flatMap((z) => [end, base, z, end, base + rise * (1 - Math.abs(z) / half), z])
	return (
		<>
			<InkSolid
				geometry={geometry}
				position={[0, base, 0]}
				rotation={[0, Math.PI / 2, 0]}
				color={color ?? finish.shingle}
				ink={finish.ink}
			/>
			<InkLines points={[...courses, ...boards]} ink={finish.ink} />
		</>
	)
}

/** An inn sign on a bracket arm, swinging from two short chains, a maple leaf painted on. */
export function HangingSign({
	position,
	board: cut = 0,
	finish,
}: {
	position: Vec3
	/** 0 a wide board, 1 a tall board, 2 a round one. */
	board?: number
	finish: MapleFinish
}) {
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
	return (
		<>
			<InkParts
				parts={[
					{ box: [0.36, 0.04, 0.04], at: [x, y, z] },
					{ box: [0.2, 0.04, 0.04], at: [x - 0.1, y - 0.07, z], turn: [0, 0, 0.8] },
				]}
				color={finish.timber}
				ink={finish.ink}
			/>
			<InkLines points={[...chain(x - 0.08), ...chain(x + 0.1)]} ink={finish.ink} />
			<InkParts parts={[sign]} color={finish.kraft} ink={finish.ink} />
			<InkParts
				parts={[
					{ box: [0.08, 0.08, 0.01], at: [x + 0.01, hang, z + 0.018], turn: [0, 0, Math.PI / 4] },
				]}
				color={finish.gifts[0] ?? finish.signal}
				ink={finish.ink}
			/>
		</>
	)
}

/** Hewn log walls on the two visible faces, crossing at notched corners with end grain showing. */
export function LogWalls({ walls, finish }: { walls: number; finish: MapleFinish }) {
	const courses = (start: number) =>
		range(Math.floor((walls - 0.06 - start) / 0.14) + 1).map((i) => start + i * 0.14)
	const front = courses(0.06).map((y): Part => ({ box: [1.78, 0.12, 0.12], at: [0, y, 0.8] }))
	const side = courses(0.13).map((y): Part => ({ box: [0.12, 0.12, 1.78], at: [0.8, y, 0] }))
	const ends = [
		...front.flatMap((log) => grain([0.891, log.at[1], 0.8], "x", 0.04)),
		...side.flatMap((log) => grain([0.8, log.at[1], 0.891], "z", 0.04)),
	]
	return (
		<>
			<InkParts parts={[...front, ...side]} color={finish.face} ink={finish.ink} />
			<InkLines points={ends} ink={finish.ink} />
		</>
	)
}

/** Height of the gate's header board centre above the post tops, where the service mark hangs. */
export const GATE_MARK = { y: 0.26, z: 0.497 } as const

/** An open timber gate: four posts on stone footings, braced beams, a header board for the
 * mark and health plates, and a light shake roof, so the passage stays see-through. */
export function MapleGate({ posts, finish }: { posts: number; finish: MapleFinish }) {
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
	return (
		<>
			<InkParts parts={footings} color={finish.stone} ink={finish.ink} />
			<InkParts parts={timber} color={finish.timber} ink={finish.ink} />
			<InkBox
				size={[1.3, 0.44, 0.06]}
				position={[0, posts + GATE_MARK.y, 0.45]}
				color={finish.face}
				ink={finish.ink}
			/>
			{[-0.365, 0.365].map((x) => (
				<InkPlate
					key={x}
					size={[0.2, 0.3]}
					position={[x, posts + GATE_MARK.y, 0.481]}
					normal="z"
					color={finish.signal}
					ink={finish.ink}
				/>
			))}
			<GableRoof
				base={top}
				half={0.56}
				rise={0.28}
				length={1.62}
				color={finish.kraft}
				finish={finish}
			/>
			<Bunting from={[-0.5, posts - 0.05, 0.56]} to={[0.5, posts - 0.05, 0.56]} finish={garland} />
			<HangingSign
				position={[0.87, posts - 0.12, 0.45]}
				board={variant(finish.seed, 8, 3)}
				finish={finish}
			/>
		</>
	)
}

/** Smoke that reads request volume: one lazy wisp near idle, a thick fast column when busy,
 * sooty when the service is degraded, none at all when idle. Frozen when paused. */
export function MapleSmoke({ position, finish }: { position: Vec3; finish: MapleFinish }) {
	const puffs = useRef<Array<THREE.Group | null>>([])
	const elapsed = useRef(0)
	const [puff] = useState(() => {
		const faces = shadeFaces(new THREE.IcosahedronGeometry(0.13, 0))
		return { faces, lines: new THREE.EdgesGeometry(faces, 20) }
	})
	useMountEffect(() => () => {
		puff.faces.dispose()
		puff.lines.dispose()
	})
	const count = finish.activity <= 0 ? 0 : 1 + Math.round(finish.activity * 4)
	const speed = 0.16 + finish.activity * 0.4
	const size = 0.55 + finish.activity * 0.7
	useFrame((_, delta) => {
		if (finish.running) elapsed.current += Math.min(delta, 0.05)
		puffs.current.forEach((group, i) => {
			if (!group) return
			const t = (elapsed.current * speed + i / count) % 1
			group.position.set(t * 0.3, t * (0.7 + finish.activity * 0.6), -t * 0.1)
			group.scale.setScalar(Math.max(0.001, Math.sin(Math.PI * t) * (0.7 + t * 0.6) * size))
		})
	})
	const color = finish.trouble === "degraded" ? finish.iron : finish.tape
	return (
		<group position={[...position]}>
			{range(count).map((i) => (
				<group
					key={i}
					ref={(group) => {
						puffs.current[i] = group
					}}
				>
					<mesh geometry={puff.faces}>
						<PaperMaterial color={color} />
					</mesh>
					<InkOutline geometry={puff.lines} ink={finish.ink} />
				</group>
			))}
		</group>
	)
}

/** A little sugar-bush worker in a plaid shirt and toque, holding a wrench or shouldering a log. */
export function Worker({
	position,
	holds,
	finish,
}: {
	position: Vec3
	holds: "wrench" | "log"
	finish: MapleFinish
}) {
	const [x, y, z] = position
	const at = (dx: number, dy: number, dz: number): Vec3 => [x + dx, y + dy, z + dz]
	const tool: Part[] =
		holds === "wrench"
			? [
					{ box: [0.022, 0.13, 0.022], at: at(0.09, 0.22, -0.06), turn: [-0.7, 0, 0] },
					{ box: [0.05, 0.03, 0.03], at: at(0.09, 0.27, -0.11), turn: [-0.7, 0, 0] },
				]
			: []
	return (
		<>
			<InkParts
				parts={[{ box: [0.1, 0.16, 0.07], at: at(0, 0.08, 0) }, ...tool]}
				color={finish.iron}
				ink={finish.ink}
			/>
			<InkParts
				parts={[{ box: [0.13, 0.15, 0.09], at: at(0, 0.235, 0) }]}
				color={finish.gifts[0] ?? finish.signal}
				ink={finish.ink}
			/>
			<InkParts
				parts={[{ box: [0.08, 0.08, 0.08], at: at(0, 0.35, 0) }]}
				color={finish.tape}
				ink={finish.ink}
			/>
			<InkParts
				parts={[{ box: [0.09, 0.045, 0.09], at: at(0, 0.41, 0) }]}
				color={finish.gifts[2] ?? finish.kraft}
				ink={finish.ink}
			/>
			{holds === "log" && (
				<InkParts
					parts={[
						{ prism: [0.045, 0.045, 0.34, 8], at: at(0.085, 0.34, 0), turn: [Math.PI / 2, 0, 0] },
					]}
					color={finish.kraft}
					ink={finish.ink}
				/>
			)}
		</>
	)
}

/** A red warning flag on a pole at the pad corner: this service is failing. */
function WarningFlag({ position, finish }: { position: Vec3; finish: MapleFinish }) {
	const [x, y, z] = position
	return (
		<>
			<InkParts
				parts={[
					{ prism: [0.018, 0.018, 0.9, 6], at: [x, y + 0.45, z] },
					{ box: [0.1, 0.05, 0.1], at: [x, y + 0.025, z] },
				]}
				color={finish.timber}
				ink={finish.ink}
			/>
			<InkParts
				parts={[{ box: [0.26, 0.16, 0.012], at: [x - 0.14, y + 0.8, z] }]}
				color={finish.gifts[0] ?? finish.signal}
				ink={finish.ink}
			/>
		</>
	)
}

/** Two planks nailed across a z-facing window. */
export function BoardedWindow({ center, finish }: { center: Vec3; finish: MapleFinish }) {
	const [x, y, z] = center
	return (
		<InkParts
			parts={[-0.45, 0.45].map((lean, i): Part => ({
				box: [0.44, 0.06, 0.02],
				at: [x, y, z + 0.035 + i * 0.02],
				turn: [0, 0, lean],
			}))}
			color={finish.timber}
			ink={finish.ink}
		/>
	)
}

/** Rope-and-lantern border round a selected pad, open at the midlines where belts come in. */
function LanternRing({ finish }: { finish: MapleFinish }) {
	const [edge, near, rope] = [1.15, 0.7, 0.2]
	const corners = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => [sx * edge, sz * edge] as const))
	const posts = corners.flatMap(([cx, cz]) => [
		[cx, cz] as const,
		[Math.sign(cx) * near, cz] as const,
		[cx, Math.sign(cz) * near] as const,
	])
	// Each rope sags a little between its corner post and the post nearest the midline.
	const span = (a: readonly [number, number], b: readonly [number, number]) => {
		const mid = [(a[0] + b[0]) / 2, rope - 0.06, (a[1] + b[1]) / 2]
		return [a[0], rope, a[1], ...mid, ...mid, b[0], rope, b[1]]
	}
	const ropes = corners.flatMap(([cx, cz]) => [
		...span([cx, cz], [Math.sign(cx) * near, cz]),
		...span([cx, cz], [cx, Math.sign(cz) * near]),
	])
	return (
		<>
			<InkParts
				parts={posts.map(([x, z]): Part => ({ box: [0.05, 0.24, 0.05], at: [x, 0.12, z] }))}
				color={finish.timber}
				ink={finish.ink}
			/>
			<InkParts
				parts={posts.map(([x, z]): Part => ({ box: [0.08, 0.09, 0.08], at: [x, 0.285, z] }))}
				color={finish.glow}
				ink={finish.ink}
			/>
			<InkLines points={ropes} ink={finish.ink} />
		</>
	)
}

/** Where a visiting worker stands on each machine's pad, clear of belts and props. */
const WORKER_SPOT = {
	processor: [-0.5, 0, 1.0],
	tank: [-0.45, 0, 1.0],
	loader: [0.55, 0, 1.0],
	gateway: [-0.95, 0, 0.8],
	shed: [0.45, 0, 1.02],
} satisfies Record<MachineKind, Vec3>

/** Live state drawn as sugar-bush life: a worker fixing an elevated machine, a warning flag on a
 * degraded one, a woodcutter at a busy dock, and a lantern rope round the selection. */
export function MapleState({
	kind,
	selected,
	finish,
}: {
	kind: MachineKind
	selected: boolean
	finish: MapleFinish
}) {
	return (
		<>
			{finish.trouble === "elevated" && (
				<Worker position={WORKER_SPOT[kind]} holds="wrench" finish={finish} />
			)}
			{finish.trouble === "degraded" && <WarningFlag position={[0.98, 0, 1.0]} finish={finish} />}
			{kind === "loader" && finish.activity >= 0.5 && (
				<Worker position={[0.98, 0, -0.95]} holds="log" finish={finish} />
			)}
			{selected && <LanternRing finish={finish} />}
		</>
	)
}

const TONES = ["timber", "kraft", "iron", "soil", "moss", "pumpkin", "water", "linen", "paint"] as const
type Tone = (typeof TONES)[number]

/** A yard solid in local terms: `a` runs along the spot, `b` across it, y up. A prism may lie
 * along a or b instead of standing. */
type Bit = { tone: Tone; at: Vec3 } & (
	| { box: readonly [number, number, number] }
	| { prism: readonly [number, number, number, number]; lie?: "a" | "b" }
)

const box = (tone: Tone, size: readonly [number, number, number], at: Vec3): Bit => ({ tone, box: size, at })
const prism = (
	tone: Tone,
	size: readonly [number, number, number, number],
	at: Vec3,
	lie?: "a" | "b",
): Bit => ({
	tone,
	prism: size,
	at,
	lie,
})

/** Small homestead props, each about half a module long, built along `a`. */
const YARD_PROPS: ReadonlyArray<() => Bit[]> = [
	// Vegetable patch: a soil bed with three rows of greens.
	() => [
		box("soil", [0.5, 0.04, 0.3], [0, 0.02, 0]),
		...[-0.09, 0, 0.09].flatMap((b) =>
			[-0.18, -0.06, 0.06, 0.18].map((a) => box("moss", [0.06, 0.06, 0.06], [a, 0.07, b])),
		),
	],
	// Woodpile: two logs with one on top.
	() => [
		prism("kraft", [0.06, 0.06, 0.42, 8], [0, 0.06, -0.065], "a"),
		prism("kraft", [0.06, 0.06, 0.42, 8], [0, 0.06, 0.065], "a"),
		prism("kraft", [0.06, 0.06, 0.42, 8], [0, 0.165, 0], "a"),
	],
	// Rain barrel with two hoops and a dark water top.
	() => [
		prism("timber", [0.1, 0.1, 0.24, 8], [0, 0.12, 0]),
		prism("iron", [0.106, 0.106, 0.025, 8], [0, 0.05, 0]),
		prism("iron", [0.106, 0.106, 0.025, 8], [0, 0.19, 0]),
		prism("water", [0.085, 0.085, 0.006, 8], [0, 0.242, 0]),
	],
	// Bench, its back to the machine and its seat to the camera.
	() => [
		box("timber", [0.42, 0.03, 0.12], [0, 0.14, 0]),
		box("timber", [0.03, 0.13, 0.1], [-0.17, 0.065, 0]),
		box("timber", [0.03, 0.13, 0.1], [0.17, 0.065, 0]),
		box("timber", [0.42, 0.1, 0.02], [0, 0.24, -0.06]),
	],
	// Mailbox on a post.
	() => [
		box("timber", [0.04, 0.26, 0.04], [0, 0.13, 0]),
		box("paint", [0.17, 0.09, 0.09], [0, 0.3, 0]),
		box("iron", [0.015, 0.08, 0.015], [0.06, 0.37, 0.05]),
	],
	// Washing line between two posts, sheets pegged out.
	() => [
		box("timber", [0.035, 0.42, 0.035], [-0.26, 0.21, 0]),
		box("timber", [0.035, 0.42, 0.035], [0.26, 0.21, 0]),
		box("linen", [0.11, 0.13, 0.01], [-0.13, 0.33, 0]),
		box("paint", [0.09, 0.1, 0.01], [0, 0.345, 0]),
		box("linen", [0.11, 0.13, 0.01], [0.13, 0.33, 0]),
		box("iron", [0.52, 0.008, 0.008], [0, 0.4, 0]),
	],
	// Pumpkin pile, it is autumn.
	() => [
		prism("pumpkin", [0.075, 0.075, 0.09, 8], [-0.07, 0.045, 0]),
		prism("pumpkin", [0.06, 0.06, 0.075, 8], [0.08, 0.0375, 0.04]),
		prism("pumpkin", [0.065, 0.065, 0.08, 8], [0, 0.125, 0.01]),
		box("moss", [0.02, 0.04, 0.02], [0, 0.18, 0.01]),
	],
	// Hand cart with two wheels and shafts.
	() => [
		box("kraft", [0.32, 0.1, 0.22], [-0.04, 0.17, 0]),
		prism("iron", [0.085, 0.085, 0.03, 8], [-0.04, 0.085, -0.13], "b"),
		prism("iron", [0.085, 0.085, 0.03, 8], [-0.04, 0.085, 0.13], "b"),
		box("timber", [0.22, 0.025, 0.025], [0.22, 0.17, -0.08]),
		box("timber", [0.22, 0.025, 0.025], [0.22, 0.17, 0.08]),
	],
]

type Spot = { x: number; z: number; along: "x" | "z" }

/** Free pad corners per kind: off the belt midlines, clear of workers, flags, porches and the
 * selection posts, within |x|, |z| <= 1.2. */
const YARD_SPOTS = {
	processor: [
		{ x: -0.95, z: 1.0, along: "x" },
		{ x: -1.0, z: 0.4, along: "z" },
		{ x: -0.98, z: -0.42, along: "z" },
		{ x: 0.95, z: -0.95, along: "x" },
		{ x: 0.45, z: 0.98, along: "x" },
	],
	tank: [
		{ x: -0.95, z: 1.0, along: "x" },
		{ x: -1.0, z: 0.4, along: "z" },
		{ x: -0.98, z: -0.42, along: "z" },
		{ x: 0.95, z: -0.95, along: "x" },
		{ x: 0.45, z: 0.98, along: "x" },
	],
	loader: [
		{ x: -1.0, z: 0.4, along: "z" },
		{ x: -0.98, z: -0.42, along: "z" },
	],
	gateway: [
		{ x: -1.0, z: 0.4, along: "z" },
		{ x: -0.98, z: -0.42, along: "z" },
		{ x: 0.95, z: -0.95, along: "x" },
	],
	shed: [
		{ x: -0.95, z: 1.0, along: "x" },
		{ x: -1.0, z: 0.4, along: "z" },
		{ x: -0.98, z: -0.42, along: "z" },
		{ x: 0.95, z: -0.95, along: "x" },
	],
} satisfies Record<MachineKind, readonly Spot[]>

function placeBit(bit: Bit, { x, z, along }: Spot): Part {
	const [a, y, b] = bit.at
	const at: Vec3 = along === "x" ? [x + a, y, z + b] : [x + b, y, z + a]
	if ("box" in bit) {
		const [sa, h, sb] = bit.box
		return { box: along === "x" ? [sa, h, sb] : [sb, h, sa], at }
	}
	// A lying prism turns its axis onto world x or z, depending on how the spot runs.
	const axis = bit.lie === undefined ? undefined : (bit.lie === "a") === (along === "x") ? "x" : "z"
	const turn: Vec3 = axis === "x" ? [0, 0, Math.PI / 2] : axis === "z" ? [Math.PI / 2, 0, 0] : [0, 0, 0]
	return { prism: bit.prism, at, turn }
}

/** One or two seeded homestead props on the pad, one merged batch per colour. */
export function Yard({ kind, finish }: { kind: MachineKind; finish: MapleFinish }) {
	const spots: readonly Spot[] = YARD_SPOTS[kind]
	const count = Math.min(spots.length, 1 + variant(finish.seed, 20, 2))
	const first = variant(finish.seed, 21, spots.length)
	const bits = range(count).flatMap((i) => {
		const spot = spots[(first + i * (spots.length > 2 ? 2 : 1)) % spots.length]
		const make = YARD_PROPS[variant(finish.seed, 22 + i, YARD_PROPS.length)]
		return spot && make ? make().map((bit) => ({ tone: bit.tone, part: placeBit(bit, spot) })) : []
	})
	const tones = {
		timber: finish.timber,
		kraft: finish.kraft,
		iron: finish.iron,
		soil: finish.soil,
		moss: finish.moss,
		pumpkin: finish.gifts[1] ?? finish.kraft,
		water: finish.water,
		linen: finish.tape,
		paint: finish.gifts[0] ?? finish.signal,
	} satisfies Record<Tone, string>
	return (
		<>
			{TONES.map((tone) => (
				<InkParts
					key={tone}
					parts={bits.filter((bit) => bit.tone === tone).map((bit) => bit.part)}
					color={tones[tone]}
					ink={finish.ink}
				/>
			))}
		</>
	)
}

/** The porchless door: stone steps up to the sill and a small shingled hood. */
export function DoorSteps({ door, finish }: { door: Vec3; finish: MapleFinish }) {
	const [x, y, z] = door
	const floor = y - 0.18
	return (
		<>
			<InkParts
				parts={[
					{ box: [0.14, floor - 0.004, 0.46], at: [x + 0.07, (floor - 0.004) / 2, z] },
					{ box: [0.12, floor / 2, 0.4], at: [x + 0.2, floor / 4, z] },
				]}
				color={finish.stone}
				ink={finish.ink}
			/>
			<InkParts
				parts={[{ box: [0.16, 0.04, 0.56], at: [x + 0.07, y + 0.22, z], turn: [0, 0, -0.3] }]}
				color={finish.shingle}
				ink={finish.ink}
			/>
		</>
	)
}

/** A planter under a z-facing window with three autumn blooms. */
export function FlowerBox({ position, finish }: { position: Vec3; finish: MapleFinish }) {
	const [x, y, z] = position
	return (
		<>
			<InkParts
				parts={[{ box: [0.42, 0.1, 0.12], at: [x, y, z + 0.06] }]}
				color={finish.timber}
				ink={finish.ink}
			/>
			{[-0.14, 0, 0.14].map((dx, i) => (
				<InkParts
					key={dx}
					parts={[{ box: [0.08, 0.08, 0.08], at: [x + dx, y + 0.1, z + 0.06] }]}
					color={finish.gifts[(i + 1) % finish.gifts.length] ?? finish.face}
					ink={finish.ink}
				/>
			))}
		</>
	)
}
