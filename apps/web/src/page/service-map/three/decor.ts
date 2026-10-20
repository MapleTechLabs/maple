import * as THREE from "three"
import { type Child, group, inkBox, inkLines, inkSolid, mesh, type Scope, type Vec3 } from "./kit"
import type { MachineFinish } from "./props"

/** A flat, double-sided triangle with an ink edge: pennants, bunting, pinwheel blades. */
export function flag(
	_scope: Scope,
	{ corners, color, ink }: { corners: readonly [Vec3, Vec3, Vec3]; color: string; ink: string },
): Child {
	const geometry = new THREE.BufferGeometry()
	geometry.setAttribute("position", new THREE.Float32BufferAttribute(corners.flat(), 3))
	const [a, b, c] = corners
	return [
		mesh(
			geometry,
			new THREE.MeshBasicMaterial({
				color,
				side: THREE.DoubleSide,
				polygonOffset: true,
				polygonOffsetFactor: 1,
				polygonOffsetUnits: 1,
			}),
		),
		inkLines([...a, ...b, ...b, ...c, ...c, ...a], ink),
	]
}

/** A sagging string of party flags across a wall's front face. */
export function bunting(scope: Scope, { from, to, finish }: { from: Vec3; to: Vec3; finish: MachineFinish }) {
	const flags = 6
	const at = (t: number) => {
		const sag = Math.sin(Math.PI * t) * 0.16
		return [
			from[0] + (to[0] - from[0]) * t,
			from[1] + (to[1] - from[1]) * t - sag,
			from[2] + (to[2] - from[2]) * t,
		] as const
	}
	const string = Array.from({ length: 12 }, (_, i) => [...at(i / 12), ...at((i + 1) / 12)]).flat()
	return group({}, [
		inkLines(string, finish.ink),
		Array.from({ length: flags }, (_, i) => {
			const a = at((i + 0.15) / flags),
				b = at((i + 0.85) / flags),
				mid = at((i + 0.5) / flags)
			return flag(scope, {
				corners: [[...a], [...b], [mid[0], mid[1] - 0.2, mid[2]]],
				color: finish.gifts[i % finish.gifts.length] ?? finish.face,
				ink: finish.ink,
			})
		}),
	])
}

/** A hanging lantern on a bracket beside an x-facing door, lit in Maple amber. */
export function lantern(_scope: Scope, { position, finish }: { position: Vec3; finish: MachineFinish }) {
	const [x, y, z] = position
	return group({}, [
		inkLines(
			[x, y + 0.2, z, x + 0.14, y + 0.2, z, x + 0.14, y + 0.2, z, x + 0.14, y + 0.12, z],
			finish.ink,
		),
		inkBox({
			size: [0.1, 0.13, 0.1],
			position: [x + 0.14, y + 0.05, z],
			color: finish.gifts[2] ?? finish.signal,
			ink: finish.ink,
		}),
		inkBox({
			size: [0.13, 0.03, 0.13],
			position: [x + 0.14, y + 0.125, z],
			color: finish.face,
			ink: finish.ink,
		}),
	])
}

/** A sugaring spout tapped into a vat with its sap bucket hanging below. */
export function mapleTap(_scope: Scope, { position, finish }: { position: Vec3; finish: MachineFinish }) {
	const bucket = new THREE.CylinderGeometry(0.11, 0.08, 0.2, 6)
	const [x, y, z] = position
	return group({}, [
		inkBox({ size: [0.14, 0.04, 0.04], position: [x + 0.07, y, z], color: finish.face, ink: finish.ink }),
		inkLines([x + 0.12, y, z, x + 0.12, y - 0.12, z], finish.ink),
		inkSolid({
			geometry: bucket,
			position: [x + 0.12, y - 0.22, z],
			color: finish.face,
			ink: finish.ink,
		}),
		inkLines(ringAt([x + 0.12, y - 0.13, z], 0.105, 6), finish.ink),
	])
}

function ringAt([x, y, z]: Vec3, radius: number, sides: number) {
	return Array.from({ length: sides }, (_, i) => {
		const a = (i * Math.PI * 2) / sides,
			b = ((i + 1) * Math.PI * 2) / sides
		return [
			x + radius * Math.sin(a),
			y,
			z + radius * Math.cos(a),
			x + radius * Math.sin(b),
			y,
			z + radius * Math.cos(b),
		]
	}).flat()
}

/** Split firewood stacked three, two, one, end grain toward the camera's right. */
export function logPile(_scope: Scope, { finish, base }: { finish: MachineFinish; base: number }) {
	const log = new THREE.CylinderGeometry(0.15, 0.15, 1.1, 8)
	const logs = [
		[-0.3, 0],
		[0, 0],
		[0.3, 0],
		[-0.15, 1],
		[0.15, 1],
		[0, 2],
	] as const
	return group(
		{},
		logs.map(([z, row]) => {
			const y = base + 0.15 + row * 0.26
			return group({}, [
				inkSolid({
					geometry: log,
					position: [0, y, z + 0.25],
					rotation: [0, 0, Math.PI / 2],
					color: finish.kraft,
					ink: finish.ink,
				}),
				inkLines(endGrain([0.551, y, z + 0.25]), finish.ink),
			])
		}),
	)
}

/** Growth rings on the cut end of an x-aligned log. */
function endGrain([x, y, z]: Vec3) {
	return Array.from({ length: 8 }, (_, i) => {
		const a = (i * Math.PI) / 4,
			b = ((i + 1) * Math.PI) / 4
		return [
			x,
			y + 0.07 * Math.sin(a),
			z + 0.07 * Math.cos(a),
			x,
			y + 0.07 * Math.sin(b),
			z + 0.07 * Math.cos(b),
		]
	}).flat()
}

/** A clump of red-capped toadstools. */
export function toadstools(_scope: Scope, { position, finish }: { position: Vec3; finish: MachineFinish }) {
	const cap = new THREE.CylinderGeometry(0.03, 0.13, 0.1, 8)
	const [x, y, z] = position
	const clumps = [
		[0, 0, 1],
		[0.2, 0.12, 0.75],
		[-0.1, 0.22, 0.6],
	] as const
	return group(
		{},
		clumps.map(([dx, dz, scale]) =>
			group({ position: [x + dx, y, z + dz], scale }, [
				inkBox({
					size: [0.07, 0.16, 0.07],
					position: [0, 0.08, 0],
					color: finish.tape,
					ink: finish.ink,
				}),
				inkSolid({
					geometry: cap,
					position: [0, 0.2, 0],
					color: finish.gifts[0] ?? finish.signal,
					ink: finish.ink,
				}),
			]),
		),
	)
}
