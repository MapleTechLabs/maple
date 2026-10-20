import { FACE_TONE, fade, type InkPalette } from "../../../components/service-map/three/appearance"
import type { FactoryLink } from "../../../components/service-map/three/factory-routing"
import type { District } from "../../../components/service-map/three/spatial-layout"
import * as THREE from "three"
import {
	type Child,
	group,
	inkBox,
	inkLines,
	inkOutline,
	mesh,
	paperMaterial,
	type Scope,
	shadeFaces,
	type Vec3,
} from "./kit"
import { linkSeed } from "./transport"

// The zone and path drawing: stone terraces, meadow mats, worn paths, terrace steps and their
// helpers.

/** Zones and terraces are solid plinths standing on the paper. */
export const PLINTH_FLOOR = -0.14

const MOSS = 0.07
/** Between the meadow floor (-0.15) and the mats' base, so paths never fight either. */
const WORN_Y = -0.143

/** Cascade terraces are dry-stone retaining walls under a moss mat, with grass
 * drooping over the top edge so the cut sits naturally in the meadow. */
export function stoneTerrace(
	_scope: Scope,
	{ district, palette }: { district: District; palette: InkPalette },
) {
	const [x, y, z] = district.position
	const { width, depth } = district
	const top = y + 0.16
	const body = top - MOSS - PLINTH_FLOOR
	const joints = stoneCourses(district, body)
	const edge = top - MOSS
	const front = (s: number): Vec3 => [x + s, edge, z + depth / 2 + 0.03]
	const side = (s: number): Vec3 => [x + width / 2 + 0.03, edge, z + s]
	const fringe = [
		...grassFringe(width, front, [0, 0, 1], district.id),
		...grassFringe(depth, side, [1, 0, 0], district.id),
	]
	return group({}, [
		inkBox({
			position: [x, PLINTH_FLOOR + body / 2, z],
			size: [width, body, depth],
			color: palette.stone,
			ink: palette.ink,
		}),
		inkBox({
			position: [x, top - MOSS / 2, z],
			size: [width + 0.06, MOSS, depth + 0.06],
			color: palette.plinth,
			ink: palette.ink,
		}),
		inkLines(joints, fade(palette.ink, palette.stone, 0.45)),
		inkLines(fringe, palette.evergreen),
	])
}

/** A small stable number per zone id, so wobble and tufts never reshuffle. */
function zoneSeed(id: string) {
	let seed = 7
	for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) % 997
	return seed
}

/** Atlas zones in Maple are a soft-edged mat of moss over a soil lip. The
 * outline wobbles mostly outward, never more than 0.11 inside the layout
 * rectangle, so pads stay covered and belts still land on turf. */
function meadowOutline({ id, width, depth }: District) {
	const radius = Math.min(1.1, width / 3, depth / 3)
	const rounded = new THREE.Shape()
	const [w, d] = [width / 2, depth / 2]
	rounded.moveTo(-w + radius, -d)
	rounded.lineTo(w - radius, -d)
	rounded.quadraticCurveTo(w, -d, w, -d + radius)
	rounded.lineTo(w, d - radius)
	rounded.quadraticCurveTo(w, d, w - radius, d)
	rounded.lineTo(-w + radius, d)
	rounded.quadraticCurveTo(-w, d, -w, d - radius)
	rounded.lineTo(-w, -d + radius)
	rounded.quadraticCurveTo(-w, -d, -w + radius, -d)
	const perimeter = 2 * (width + depth)
	const samples = Math.max(48, Math.round(perimeter / 0.25))
	const ring = rounded.getSpacedPoints(samples).slice(0, samples)
	const salt = zoneSeed(id)
	// Whole-number frequencies keep the noise periodic, so the outline closes cleanly.
	const waves = [
		{ k: 2, a: 0.45 },
		{ k: 5, a: 0.35 },
		{ k: Math.max(7, Math.round(perimeter / 1.6)), a: 0.2 },
	].map((wave, i) => ({ ...wave, phase: ((salt * (i + 3)) % 360) * (Math.PI / 180) }))
	const outline = ring.map((point, i) => {
		const t = i / samples
		const next = ring[(i + 1) % samples] ?? point,
			previous = ring[(i + samples - 1) % samples] ?? point
		const tangent = next.clone().sub(previous).normalize()
		const noise = waves.reduce(
			(sum, { k, a, phase }) => sum + a * Math.sin(2 * Math.PI * k * t + phase),
			0,
		)
		return point.clone().addScaledVector(new THREE.Vector2(tangent.y, -tangent.x), 0.09 + 0.2 * noise)
	})
	return new THREE.Shape(outline)
}

export function meadowMat(_scope: Scope, { district, palette }: { district: District; palette: InkPalette }) {
	const [x, y, z] = district.position
	const top = y + 0.16
	const edge = meadowOutline(district)
	const faces = new THREE.ExtrudeGeometry(edge, { depth: top - PLINTH_FLOOR, bevelEnabled: false })
	// Shape y becomes world -z, extrusion becomes height.
	faces.rotateX(-Math.PI / 2).translate(x, PLINTH_FLOOR, z)
	shadeFaces(faces)
	const lines = new THREE.EdgesGeometry(faces, 35)
	const tufts = meadowTufts(edge, x, top, z, district.id)
	const turf = mesh(faces, paperMaterial("#ffffff"))
	paintTurf(turf.geometry, palette.plinth, palette.soil)
	return group({}, [turf, inkOutline(lines, palette.ink), inkLines(tufts, palette.evergreen)])
}

/** Moss on the top face, soil on the sides, keeping the baked isometric tones.
 * Rewrites the colour attribute in place so palette changes need no new geometry. */
function paintTurf(geometry: THREE.BufferGeometry, moss: string, soil: string) {
	const normal = geometry.getAttribute("normal")
	const colors = geometry.getAttribute("color")
	if (!normal || !colors) return
	const [top, wall] = [new THREE.Color(moss), new THREE.Color(soil)]
	const tone = new THREE.Color()
	for (let i = 0; i < normal.count; i++) {
		const [nx, ny, nz] = [normal.getX(i), normal.getY(i), normal.getZ(i)]
		const shade =
			ny > 0.5
				? FACE_TONE.top
				: nz > 0.5
					? FACE_TONE.front
					: nx > 0.5
						? FACE_TONE.side
						: FACE_TONE.hidden
		tone.copy(ny > 0.5 ? top : wall).multiplyScalar(shade)
		colors.setXYZ(i, tone.r, tone.g, tone.b)
	}
	colors.needsUpdate = true
}

/** Grass blades poking up and out along the mat's edge, a pair every few steps. */
function meadowTufts(edge: THREE.Shape, x: number, top: number, z: number, seed: string) {
	const ring = edge.extractPoints(1).shape
	const salt = zoneSeed(seed)
	const points: number[] = []
	ring.forEach((point, i) => {
		if ((i + salt) % 5 !== 0) return
		const next = ring[(i + 1) % ring.length] ?? point
		const tangent = next.clone().sub(point).normalize()
		const [ox, oz] = [tangent.y, tangent.x]
		const [px, pz] = [x + point.x, z - point.y]
		for (const lean of [0.03, 0.07]) {
			const height = 0.07 + ((salt + i) % 3) * 0.025
			points.push(px, top, pz, px + ox * lean, top + height, pz + oz * lean)
		}
	})
	return points
}

/** Short drooping grass strokes along an edge, outward along `out`, seeded so a
 * zone keeps its tufts across renders. */
function grassFringe(length: number, at: (s: number) => Vec3, out: Vec3, seed: string) {
	const points: number[] = []
	const salt = zoneSeed(seed)
	for (let i = 0, s = -length / 2 + 0.15; s < length / 2 - 0.1; i++) {
		const [px, py, pz] = at(s)
		const drop = 0.05 + (((salt + i * 7) % 5) / 5) * 0.08
		const lean = 0.02 + ((salt + i * 3) % 3) * 0.015
		points.push(px, py, pz, px + out[0] * lean, py - drop, pz + out[2] * lean)
		s += 0.14 + ((salt + i * 11) % 4) * 0.05
	}
	return points
}

/** Trodden earth under every Atlas boardwalk: one ragged strip per belt, all
 * merged into one mesh just above the meadow. Mats sit higher and cover it. */
export function wornPaths(
	_scope: Scope,
	{ links, palette }: { links: ReadonlyArray<FactoryLink>; palette: InkPalette },
) {
	const vertices: number[] = [],
		indices: number[] = []
	for (const link of links) {
		const salt = linkSeed(link.id)
		const length = link.curve.getLength()
		const samples = Math.max(8, Math.ceil(length / 0.2))
		const start = vertices.length / 3
		for (let i = 0; i <= samples; i++) {
			const point = link.curve.getPointAt(i / samples)
			const tangent = link.curve.getTangentAt(i / samples)
			const side = new THREE.Vector3(tangent.z, 0, -tangent.x).normalize()
			for (const sign of [-1, 1]) {
				// Ragged edges: each side frays on its own seeded rhythm.
				const fray =
					Math.sin(i * 1.7 + salt + sign * 2.3) * 0.5 + Math.sin(i * 0.61 + salt * 0.37) * 0.5
				const half = (link.kind === "conveyor" ? 0.36 : 0.24) + 0.16 + fray * 0.08
				const edge = point.clone().addScaledVector(side, sign * half)
				vertices.push(edge.x, WORN_Y, edge.z)
			}
			if (i < samples) {
				const n = start + i * 2
				indices.push(n, n + 2, n + 1, n + 1, n + 2, n + 3)
			}
		}
	}
	const paths = new THREE.BufferGeometry()
	paths.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3))
	paths.setIndex(indices)
	const meadow = fade(palette.plinth, palette.paper, 0.4)
	return mesh(
		paths,
		new THREE.MeshBasicMaterial({
			color: fade(palette.soil, meadow, 0.35),
			side: THREE.DoubleSide,
			polygonOffset: true,
			polygonOffsetFactor: 1,
			polygonOffsetUnits: 1,
		}),
	)
}

/** Timber steps down the gap between neighbouring Cascade terraces. They sit at
 * the near end of the shared edge, past the outermost machine, where no belt runs. */
export function terraceSteps(
	_scope: Scope,
	{ districts, palette }: { districts: ReadonlyArray<District>; palette: InkPalette },
): Child {
	const tiers = districts.toSorted((a, b) => a.position[0] - b.position[0])
	return tiers.slice(1).flatMap((lower, i) => {
		const upper = tiers[i]
		if (!upper) return []
		const from = upper.position[0] + upper.width / 2,
			to = lower.position[0] - lower.width / 2
		const drop = upper.position[1] - lower.position[1]
		if (to - from < 0.3 || drop <= 0) return []
		const z = Math.min(upper.position[2] + upper.depth / 2, lower.position[2] + lower.depth / 2) - 0.45
		const count = 3
		const tread = (to - from) / count
		const lowTop = lower.position[1] + 0.16
		return Array.from({ length: count }, (_, step) => {
			const height = lowTop + (drop * (count - step)) / (count + 1) - PLINTH_FLOOR
			return inkBox({
				position: [from + tread * (step + 0.5), PLINTH_FLOOR + height / 2, z],
				size: [tread, height, 0.5],
				color: palette.kraft,
				ink: palette.ink,
			})
		})
	})
}

/** Dry-stone courses on the two visible faces: bed joints every course and
 * staggered head joints with a little irregular spacing, like laid fieldstone. */
function stoneCourses({ position: [x, , z], width, depth }: District, body: number) {
	const joints: number[] = []
	const course = 0.17
	const courses = Math.max(1, Math.round(body / course))
	const rise = body / courses
	const faces = [
		{ length: width, at: (s: number, h: number) => [x + s, h, z + depth / 2] },
		{ length: depth, at: (s: number, h: number) => [x + width / 2, h, z + s] },
	]
	for (let c = 0; c < courses; c++) {
		const low = PLINTH_FLOOR + c * rise,
			high = low + rise
		for (const { length, at } of faces) {
			if (c > 0) joints.push(...at(-length / 2, low), ...at(length / 2, low))
			let s = -length / 2 + 0.12 + (c % 2) * 0.17
			for (let stone = c; s < length / 2 - 0.08; stone++) {
				joints.push(...at(s, low), ...at(s, high))
				s += 0.3 + ((stone * 7) % 5) * 0.04
			}
		}
	}
	return joints
}
