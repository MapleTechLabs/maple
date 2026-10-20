import * as THREE from "three"
import { FACE_TONE } from "./appearance"
import type { Vec3 } from "./types"

// The pure half of the scenery kit, so the drawings can be shared outside the 3D scene.

/** Seeded noise in [0, 1): a layout always grows the same forest. */
export const hash = (x: number, z: number) => Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1

/** The districts' bounding box, plus the ground level outside every zone. */
export interface Bounds {
	minX: number
	maxX: number
	minZ: number
	maxZ: number
	floor: number
}

export interface Pose {
	position: Vec3
	rotation?: Vec3
	scale?: Vec3 | number
	color: string
}

const toneOf = (x: number, y: number, z: number) =>
	y > 0.5 ? FACE_TONE.top : z > 0.5 ? FACE_TONE.front : x > 0.5 ? FACE_TONE.side : FACE_TONE.hidden

/** Collects every static scenery solid into one shaded mesh and one ink draw. */
export function createSketch() {
	const faces: number[] = []
	const colors: number[] = []
	const ink: number[] = []
	const tint = new THREE.Color()
	const matrixOf = ({ position, rotation = [0, 0, 0], scale = 1 }: Pose) =>
		new THREE.Matrix4().compose(
			new THREE.Vector3(...position),
			new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
			typeof scale === "number" ? new THREE.Vector3(scale, scale, scale) : new THREE.Vector3(...scale),
		)
	const solid = (geometry: THREE.BufferGeometry, pose: Pose) => {
		const matrix = matrixOf(pose)
		const shell = (geometry.index ? geometry.toNonIndexed() : geometry.clone()).applyMatrix4(matrix)
		shell.computeVertexNormals()
		const position = shell.getAttribute("position")
		const normal = shell.getAttribute("normal")
		tint.set(pose.color)
		for (let i = 0; i < position.count; i++) {
			const tone = toneOf(normal.getX(i), normal.getY(i), normal.getZ(i))
			faces.push(position.getX(i), position.getY(i), position.getZ(i))
			colors.push(tint.r * tone, tint.g * tone, tint.b * tone)
		}
		const edges = new THREE.EdgesGeometry(geometry, 20).applyMatrix4(matrix)
		ink.push(...edges.getAttribute("position").array)
		shell.dispose()
		edges.dispose()
	}
	/** Flat triangles facing the sky, e.g. water, already in world space. */
	const flat = (triangles: number[], color: string) => {
		tint.set(color)
		faces.push(...triangles)
		for (let i = 0; i < triangles.length / 3; i++) colors.push(tint.r, tint.g, tint.b)
	}
	/** World-space triangles shaded by their own facing, for terrain walls. */
	const facets = (triangles: number[], color: string) => {
		tint.set(color)
		for (let i = 0; i + 8 < triangles.length; i += 9) {
			const [ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0, cx = 0, cy = 0, cz = 0] = triangles.slice(
				i,
				i + 9,
			)
			const normal = new THREE.Vector3(bx - ax, by - ay, bz - az)
				.cross(new THREE.Vector3(cx - ax, cy - ay, cz - az))
				.normalize()
			const tone = toneOf(normal.x, normal.y, normal.z)
			faces.push(ax, ay, az, bx, by, bz, cx, cy, cz)
			for (let k = 0; k < 3; k++) colors.push(tint.r * tone, tint.g * tone, tint.b * tone)
		}
	}
	const lines = (points: number[]) => ink.push(...points)
	const build = () => {
		const mesh = new THREE.BufferGeometry()
		mesh.setAttribute("position", new THREE.Float32BufferAttribute(faces, 3))
		mesh.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3))
		const outline = new THREE.BufferGeometry()
		outline.setAttribute("position", new THREE.Float32BufferAttribute(ink, 3))
		return { mesh, outline }
	}
	return { solid, flat, facets, lines, build }
}

export type Sketch = ReturnType<typeof createSketch>

/** Unit prototypes shared by every scenery drawing, built per sketch and disposed after. */
export function prototypes() {
	const stock = {
		box: new THREE.BoxGeometry(1, 1, 1),
		crown: new THREE.IcosahedronGeometry(0.36, 0),
		rock: new THREE.DodecahedronGeometry(0.22, 0),
		tier: new THREE.ConeGeometry(1, 1, 7),
		log: new THREE.CylinderGeometry(1, 1, 1, 7),
		cap: new THREE.CylinderGeometry(0.25, 1, 1, 7),
		bud: new THREE.OctahedronGeometry(0.2, 0),
	}
	const dispose = () => Object.values(stock).forEach((piece) => piece.dispose())
	return { ...stock, dispose }
}

export type Prototypes = ReturnType<typeof prototypes>

/** Builds a sketch drawn by `draw` with a fresh set of prototypes; the caller owns the result. */
export function sketchOf(draw: (sketch: Sketch, stock: Prototypes) => void) {
	const sketch = createSketch()
	const stock = prototypes()
	draw(sketch, stock)
	stock.dispose()
	return sketch.build()
}
