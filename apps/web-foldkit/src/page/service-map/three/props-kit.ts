import type { MachineFinish as LegacyMachineFinish } from "../../../components/service-map/three/palette"
import * as THREE from "three"
import {
	type Child,
	group,
	inkOutline,
	mesh,
	paperMaterial,
	type Running,
	type Scope,
	shadeFaces,
	type Vec3,
} from "./kit"

/** The shared finish, its `running` read live so a pause needs no rebuild. */
export type MachineFinish = Omit<LegacyMachineFinish, "running"> & { readonly running: Running }

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
export function inkParts(
	_scope: Scope,
	{ parts, color, ink }: { parts: readonly Part[]; color: string; ink: string },
): Child {
	if (parts.length === 0) return null
	const faces = mergeParts(parts)
	const lines = new THREE.EdgesGeometry(faces, 20)
	return group({}, [mesh(faces, paperMaterial(color)), inkOutline(lines, ink)])
}

export const range = (count: number) => Array.from({ length: Math.max(0, count) }, (_, i) => i)

/** An octagon of end grain on an x- or z-facing cut. */
export function grain([x, y, z]: Vec3, normal: "x" | "z", radius: number) {
	const at = (k: number) => {
		const u = radius * Math.cos((k * Math.PI) / 4),
			v = radius * Math.sin((k * Math.PI) / 4)
		return normal === "x" ? [x, y + v, z + u] : [x + u, y + v, z]
	}
	return range(8).flatMap((k) => [...at(k), ...at(k + 1)])
}

/** Smoke that reads request volume: one lazy wisp near idle, a thick fast column when busy,
 * sooty when the service is degraded, none at all when idle. Frozen when paused. */
export function mapleSmoke(scope: Scope, { position, finish }: { position: Vec3; finish: MapleFinish }) {
	const elapsed = { value: 0 }
	const faces = shadeFaces(new THREE.IcosahedronGeometry(0.13, 0))
	const lines = new THREE.EdgesGeometry(faces, 20)
	const count = finish.activity <= 0 ? 0 : 1 + Math.round(finish.activity * 4)
	const speed = 0.16 + finish.activity * 0.4
	const size = 0.55 + finish.activity * 0.7
	const color = finish.trouble === "degraded" ? finish.iron : finish.tape
	const puffs = range(count).map(() =>
		group({}, [mesh(faces, paperMaterial(color)), inkOutline(lines, finish.ink)]),
	)
	scope.frames.push((delta) => {
		if (finish.running()) elapsed.value += Math.min(delta, 0.05)
		puffs.forEach((puff, i) => {
			const t = (elapsed.value * speed + i / count) % 1
			puff.position.set(t * 0.3, t * (0.7 + finish.activity * 0.6), -t * 0.1)
			puff.scale.setScalar(Math.max(0.001, Math.sin(Math.PI * t) * (0.7 + t * 0.6) * size))
		})
	})
	return group({ position }, puffs)
}
