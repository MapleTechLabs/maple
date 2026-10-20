import { createSketch, type Sketch } from "../../../components/service-map/three/maple-scenery-sketch"
import { FACE_TONE } from "../../../components/service-map/three/palette"
import * as THREE from "three"

// Scene parts as plain three construction. Only the lazy scene chunk imports this folder.
// A part returns `Child`: its children in declaration order, so materials are created in a
// fixed order.

export type Vec3 = readonly [number, number, number]

export type Child = THREE.Object3D | null | undefined | false | ReadonlyArray<Child>

export interface Transform {
	readonly position?: Vec3
	readonly rotation?: Vec3
	readonly scale?: Vec3 | number
}

/** A live flag a frame callback reads: `running` props become getters, so a pause needs no rebuild. */
export type Running = () => boolean

/** Per-frame work, as R3F's `useFrame((_, delta) => ...)`. */
export type FrameCallback = (delta: number) => void

/** What one build of the scene shares: frame callbacks and canvas textures. */
export interface Scope {
	readonly frames: Array<FrameCallback>
	readonly textures: Map<string, THREE.Texture>
}

export const makeScope = (): Scope => ({ frames: [], textures: new Map() })

const flatten = (children: ReadonlyArray<Child>): Array<THREE.Object3D> =>
	children.flatMap((child): Array<THREE.Object3D> => {
		if (child === null || child === undefined || child === false) return []
		if (child instanceof THREE.Object3D) return [child]
		return flatten(child)
	})

/** Applies R3F's `position`, `rotation` and `scale` props. */
export const place = <T extends THREE.Object3D>(object: T, transform: Transform = {}): T => {
	if (transform.position !== undefined) object.position.set(...transform.position)
	if (transform.rotation !== undefined) object.rotation.set(...transform.rotation)
	if (transform.scale !== undefined) {
		if (typeof transform.scale === "number") object.scale.setScalar(transform.scale)
		else object.scale.set(...transform.scale)
	}
	return object
}

/** `<group {...transform}>{children}</group>`. */
export const group = (transform: Transform, children: ReadonlyArray<Child>): THREE.Group => {
	const node = place(new THREE.Group(), transform)
	const objects = flatten(children)
	if (objects.length > 0) node.add(...objects)
	return node
}

/** Frees every geometry, material and texture under `root`. */
export const disposeTree = (root: THREE.Object3D): void => {
	root.traverse((object) => {
		if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments)) return
		object.geometry.dispose()
		const materials: ReadonlyArray<THREE.Material> = Array.isArray(object.material)
			? object.material
			: [object.material]
		materials.forEach((material) => {
			if (material instanceof THREE.MeshBasicMaterial) material.map?.dispose()
			material.dispose()
		})
	})
}

// Geometry primitives, as functions.

/** Bake the isometric face tones into vertex colors so materials stay unlit. */
export function shadeFaces(geometry: THREE.BufferGeometry) {
	const normal = geometry.getAttribute("normal")
	const colors = new Float32Array(normal.count * 3)
	for (let i = 0; i < normal.count; i++) {
		const [x, y, z] = [normal.getX(i), normal.getY(i), normal.getZ(i)]
		const tone =
			y > 0.5 ? FACE_TONE.top : z > 0.5 ? FACE_TONE.front : x > 0.5 ? FACE_TONE.side : FACE_TONE.hidden
		colors.set([tone, tone, tone], i * 3)
	}
	geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3))
	return geometry
}

/** Panel seams on the three faces the isometric camera sees, one cell apart. */
function seams([w, h, d]: Vec3, cell: number) {
	const points: number[] = []
	const steps = (length: number) =>
		Array.from(
			{ length: Math.max(0, Math.round(length / cell) - 1) },
			(_, i) => -length / 2 + (i + 1) * (length / Math.round(length / cell)),
		)
	for (const y of steps(h))
		points.push(-w / 2, y, d / 2, w / 2, y, d / 2, w / 2, y, d / 2, w / 2, y, -d / 2)
	for (const x of steps(w))
		points.push(x, -h / 2, d / 2, x, h / 2, d / 2, x, h / 2, -d / 2, x, h / 2, d / 2)
	for (const z of steps(d))
		points.push(w / 2, -h / 2, z, w / 2, h / 2, z, -w / 2, h / 2, z, w / 2, h / 2, z)
	return points
}

/** `<PaperMaterial>`: faces sit a hair behind their outlines so ink never flickers into paper. */
export const paperMaterial = (color: string) =>
	new THREE.MeshBasicMaterial({
		color,
		vertexColors: true,
		polygonOffset: true,
		polygonOffsetFactor: 1,
		polygonOffsetUnits: 1,
	})

/** A mesh of `geometry`; pass the material inline so it is built first. */
export const mesh = (
	geometry: THREE.BufferGeometry,
	material: THREE.Material | Array<THREE.Material>,
	transform?: Transform,
): THREE.Mesh => place(new THREE.Mesh(geometry, material), transform)

/** `<InkOutline>` */
export const inkOutline = (geometry: THREE.BufferGeometry, ink: string): THREE.LineSegments =>
	new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: ink }))

export interface InkBoxProps {
	readonly size: Vec3
	readonly position?: Vec3
	readonly color: string
	readonly ink: string
	/** Draw module seams every `cell` units, like stacked crates. */
	readonly cell?: number
}

/** `<InkBox>` */
export function inkBox({ size, position = [0, 0, 0], color, ink, cell }: InkBoxProps): THREE.Group {
	const [w, h, d] = size
	const faces = shadeFaces(new THREE.BoxGeometry(w, h, d))
	const edges = new THREE.EdgesGeometry(faces)
	const points = [...edges.getAttribute("position").array, ...(cell ? seams(size, cell) : [])]
	edges.dispose()
	const lines = new THREE.BufferGeometry()
	lines.setAttribute("position", new THREE.Float32BufferAttribute(points, 3))
	return group({ position }, [mesh(faces, paperMaterial(color)), inkOutline(lines, ink)])
}

export interface InkSolidProps {
	readonly geometry: THREE.BufferGeometry
	readonly position?: Vec3
	readonly rotation?: Vec3
	readonly color: string
	readonly ink: string
}

/** `<InkSolid>`: any solid outlined at its creases. Flat normals per facet. */
export function inkSolid({
	geometry,
	position = [0, 0, 0],
	rotation = [0, 0, 0],
	color,
	ink,
}: InkSolidProps): THREE.Group {
	const faces = geometry.index ? geometry.toNonIndexed() : geometry.clone()
	faces.computeVertexNormals()
	shadeFaces(faces)
	const lines = new THREE.EdgesGeometry(geometry, 20)
	return group({ position, rotation }, [mesh(faces, paperMaterial(color)), inkOutline(lines, ink)])
}

export interface InkPlateProps {
	readonly size: readonly [number, number]
	readonly position: Vec3
	readonly normal: "x" | "y" | "z"
	readonly color: string
	readonly ink: string
}

/** `<InkPlate>`: a flat outlined plate lying on a face, for doors, windows and decals. */
export function inkPlate({ size, position, normal, color, ink }: InkPlateProps): THREE.Group {
	const rotation: Vec3 =
		normal === "y" ? [-Math.PI / 2, 0, 0] : normal === "x" ? [0, Math.PI / 2, 0] : [0, 0, 0]
	const faces = new THREE.PlaneGeometry(size[0], size[1])
	const lines = new THREE.EdgesGeometry(faces)
	return group({ position, rotation }, [
		mesh(
			faces,
			new THREE.MeshBasicMaterial({
				color,
				polygonOffset: true,
				polygonOffsetFactor: -1,
				polygonOffsetUnits: -1,
			}),
		),
		inkOutline(lines, ink),
	])
}

/** `<InkLines>`: free ink strokes as point pairs. */
export function inkLines(points: ReadonlyArray<number>, ink: string): THREE.LineSegments {
	const lines = new THREE.BufferGeometry()
	lines.setAttribute("position", new THREE.Float32BufferAttribute([...points], 3))
	return inkOutline(lines, ink)
}

/** A sketch drawing: one shaded mesh and one ink draw. */
export function sketchDrawing(draw: (sketch: Sketch) => void, ink: string): THREE.Group {
	const sketch = createSketch()
	draw(sketch)
	const built = sketch.build()
	return group({}, [
		mesh(
			built.mesh,
			new THREE.MeshBasicMaterial({
				vertexColors: true,
				polygonOffset: true,
				polygonOffsetFactor: 1,
				polygonOffsetUnits: 1,
			}),
		),
		new THREE.LineSegments(built.outline, new THREE.LineBasicMaterial({ color: ink })),
	])
}
