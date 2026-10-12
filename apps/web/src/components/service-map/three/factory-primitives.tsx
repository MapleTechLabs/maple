import { useState } from "react"
import * as THREE from "three"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { FACE_TONE } from "./appearance"
import type { Vec3 } from "./types"

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
function seams([w, h, d]: [number, number, number], cell: number) {
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

/** Faces sit a hair behind their outlines so ink never flickers into paper. */
export function PaperMaterial({ color }: { color: string }) {
	return (
		<meshBasicMaterial
			color={color}
			vertexColors
			polygonOffset
			polygonOffsetFactor={1}
			polygonOffsetUnits={1}
		/>
	)
}

export function InkOutline({ geometry, ink }: { geometry: THREE.BufferGeometry; ink: string }) {
	return (
		<lineSegments geometry={geometry}>
			<lineBasicMaterial color={ink} />
		</lineSegments>
	)
}

interface InkBoxProps {
	size: [number, number, number]
	position?: Vec3
	color: string
	ink: string
	/** Draw module seams every `cell` units, like stacked crates. */
	cell?: number
}

/** Geometry is built once per mount; a new size remounts the body (see the
 * keys below), so live metrics never leave replaced GPU buffers behind. */
export function InkBox(props: InkBoxProps) {
	return <InkBoxBody key={`${props.size.join(":")}:${props.cell ?? 0}`} {...props} />
}

function InkBoxBody({ size, position = [0, 0, 0], color, ink, cell }: InkBoxProps) {
	const [{ faces, lines }] = useState(() => {
		const [w, h, d] = size
		const faces = shadeFaces(new THREE.BoxGeometry(w, h, d))
		const edges = new THREE.EdgesGeometry(faces)
		const points = [...edges.getAttribute("position").array, ...(cell ? seams([w, h, d], cell) : [])]
		edges.dispose()
		const lines = new THREE.BufferGeometry()
		lines.setAttribute("position", new THREE.Float32BufferAttribute(points, 3))
		return { faces, lines }
	})
	useMountEffect(() => () => {
		faces.dispose()
		lines.dispose()
	})
	return (
		<group position={[...position]}>
			<mesh geometry={faces}>
				<PaperMaterial color={color} />
			</mesh>
			<InkOutline geometry={lines} ink={ink} />
		</group>
	)
}

interface InkSolidProps {
	geometry: THREE.BufferGeometry
	position?: Vec3
	rotation?: Vec3
	color: string
	ink: string
}

/** Any solid outlined at its creases: octagonal tanks, pitched roofs. Takes
 * ownership of `geometry`; a new geometry remounts the body. */
export function InkSolid(props: InkSolidProps) {
	return <InkSolidBody key={props.geometry.uuid} {...props} />
}

function InkSolidBody({ geometry, position = [0, 0, 0], rotation = [0, 0, 0], color, ink }: InkSolidProps) {
	const [{ faces, lines }] = useState(() => {
		// Flat normals per facet, so an octagonal tank reads as eight drawn panels.
		const faces = geometry.index ? geometry.toNonIndexed() : geometry.clone()
		faces.computeVertexNormals()
		return { faces: shadeFaces(faces), lines: new THREE.EdgesGeometry(geometry, 20) }
	})
	useMountEffect(() => () => {
		faces.dispose()
		lines.dispose()
		geometry.dispose()
	})
	return (
		<group position={[...position]} rotation={[...rotation]}>
			<mesh geometry={faces}>
				<PaperMaterial color={color} />
			</mesh>
			<InkOutline geometry={lines} ink={ink} />
		</group>
	)
}

interface InkPlateProps {
	size: [number, number]
	position: Vec3
	normal: "x" | "y" | "z"
	color: string
	ink: string
}

/** A flat outlined plate lying on a face, for doors, windows and decals. */
export function InkPlate(props: InkPlateProps) {
	return <InkPlateBody key={props.size.join(":")} {...props} />
}

function InkPlateBody({ size, position, normal, color, ink }: InkPlateProps) {
	const rotation: Vec3 =
		normal === "y" ? [-Math.PI / 2, 0, 0] : normal === "x" ? [0, Math.PI / 2, 0] : [0, 0, 0]
	const [{ faces, lines }] = useState(() => {
		const faces = new THREE.PlaneGeometry(size[0], size[1])
		return { faces, lines: new THREE.EdgesGeometry(faces) }
	})
	useMountEffect(() => () => {
		faces.dispose()
		lines.dispose()
	})
	return (
		<group position={[...position]} rotation={[...rotation]}>
			<mesh geometry={faces}>
				<meshBasicMaterial
					color={color}
					polygonOffset
					polygonOffsetFactor={-1}
					polygonOffsetUnits={-1}
				/>
			</mesh>
			<InkOutline geometry={lines} ink={ink} />
		</group>
	)
}

/** Free ink strokes as point pairs: ladders, railings, louvres, mullions. */
export function InkLines({ points, ink }: { points: number[]; ink: string }) {
	return <InkLinesBody key={points.join(",")} points={points} ink={ink} />
}

function InkLinesBody({ points, ink }: { points: number[]; ink: string }) {
	const [geometry] = useState(() => {
		const lines = new THREE.BufferGeometry()
		lines.setAttribute("position", new THREE.Float32BufferAttribute(points, 3))
		return lines
	})
	useMountEffect(() => () => geometry.dispose())
	return <InkOutline geometry={geometry} ink={ink} />
}
