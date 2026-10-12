import { Component, useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { useMountEffect } from "@/hooks/use-mount-effect"
import type { Topology3D } from "./types"
import type { Vec3 } from "./types"
import { errorRateLevel } from "@maple/ui/lib/error-rate"
import { FACE_TONE, fade, type InkPalette } from "./appearance"
import { connectedIds, type District, type SpatialLayout, type SpatialView } from "./spatial-layout"
import { InkBox, InkLines, InkOutline, PaperMaterial, shadeFaces } from "./factory-primitives"
import { DRAG_TOLERANCE } from "./scene-input"
import { FactoryMachine } from "./factory-machines"
import { FactoryTransport, linkSeed } from "./factory-transport"
import { Scenery } from "./factory-decor"
import type { FactoryLink } from "./factory-routing"

export interface CameraCommand {
	action: "reset" | "in" | "out"
	serial: number
}
export interface SceneProps {
	topology: Topology3D
	layout: SpatialLayout
	links: FactoryLink[]
	view: SpatialView
	selectedId: string | null
	onSelect: (id: string | null) => void
	flowing: boolean
	palette: InkPalette
	command: CameraCommand
	labels: RefObject<Map<string, HTMLElement>>
}

const vector = (p: Vec3) => new THREE.Vector3(...p)
/** 2:1 isometric, the pixel-art convention: 45° azimuth, about 30° elevation. */
const ISOMETRIC = new THREE.Vector3(1, Math.SQRT2 * Math.tan(Math.PI / 6), 1).normalize().multiplyScalar(40)
/** Zones and terraces are solid plinths standing on the paper. */
const PLINTH_FLOOR = -0.14
/** Frame a little meadow around the zones, so a small topology still shows the
 * forest edge on reset without shrinking a large map much. */
const FRAME_MARGIN = 2.5

/** The camera and HTML labels share one projection. Labels stay sharp at every
 * zoom, expose actual buttons, and never cause React renders during orbit. */
function CameraRig({
	topology,
	layout,
	links,
	view,
	labels,
	selectedId,
	command,
}: Pick<SceneProps, "topology" | "layout" | "links" | "view" | "labels" | "selectedId" | "command">) {
	const { camera, gl, invalidate, size } = useThree()
	const controls = useRef<OrbitControls | null>(null)
	const lastFrame = useRef("")
	const lastCommand = useRef(-1)
	const lastProjection = useRef("")
	const probe = useMemo(() => new THREE.Vector3(), [])
	const linksById = useMemo(() => new Map(links.map((link) => [link.id, link])), [links])
	const nodesById = useMemo(() => new Map(topology.nodes.map((node) => [node.id, node])), [topology.nodes])
	const labelRevision = useMemo(
		() =>
			JSON.stringify([
				topology.nodes.map((node) => [node.id, node.label, node.throughput, node.dimmed]),
				links.map((link) => [link.id, link.edge.callsPerSecond]),
			]),
		[topology.nodes, links],
	)
	const layoutKey = useMemo(() => JSON.stringify([...layout.positions]), [layout])
	const bounds = useMemo(() => {
		const points = layout.districts.flatMap((district) =>
			[-1, 1].flatMap((x) =>
				[-1, 1].map(
					(z) =>
						new THREE.Vector3(
							district.position[0] + x * (district.width / 2 + FRAME_MARGIN),
							district.position[1],
							district.position[2] + z * (district.depth / 2 + FRAME_MARGIN),
						),
				),
			),
		)
		for (const point of layout.positions.values())
			points.push(vector(point).add(new THREE.Vector3(0, 4, 0)))
		return { points, center: new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3()) }
	}, [layout])
	useMountEffect(() => {
		const orbit = new OrbitControls(camera, gl.domElement)
		// The projection is part of the drawing: pan and zoom, never orbit.
		orbit.enableRotate = false
		orbit.enableDamping = true
		orbit.dampingFactor = 0.12
		orbit.screenSpacePanning = true
		orbit.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
		orbit.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN }
		orbit.minZoom = 0.05
		orbit.maxZoom = 100
		const onChange = () => invalidate()
		orbit.addEventListener("change", onChange)
		controls.current = orbit
		invalidate()
		return () => {
			orbit.removeEventListener("change", onChange)
			orbit.dispose()
			controls.current = null
		}
	})
	useFrame(() => {
		const orbit = controls.current
		if (!orbit || !(camera instanceof THREE.OrthographicCamera)) return
		const frameKey = `${view}:${size.width}:${size.height}:${layoutKey}`
		const newCommand = lastCommand.current !== command.serial
		if (lastFrame.current !== frameKey || (newCommand && command.action === "reset")) {
			lastFrame.current = frameKey
			camera.position.copy(bounds.center).add(ISOMETRIC)
			camera.lookAt(bounds.center)
			camera.zoom = 1
			camera.updateProjectionMatrix()
			camera.updateMatrixWorld()
			let left = Infinity,
				right = -Infinity,
				top = -Infinity,
				bottom = Infinity
			for (const point of bounds.points) {
				probe.copy(point).project(camera)
				left = Math.min(left, probe.x)
				right = Math.max(right, probe.x)
				top = Math.max(top, probe.y)
				bottom = Math.min(bottom, probe.y)
			}
			const shift = new THREE.Vector3()
				.setFromMatrixColumn(camera.matrixWorld, 0)
				.multiplyScalar(((left + right) * (camera.right - camera.left)) / 4)
				.addScaledVector(
					new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1),
					((top + bottom) * (camera.top - camera.bottom)) / 4,
				)
			camera.position.add(shift)
			const framing = size.width < 600 ? 1.6 : 1.75
			camera.zoom = Math.min(framing / (right - left), framing / (top - bottom))
			orbit.target.copy(bounds.center).add(shift)
			camera.updateProjectionMatrix()
			invalidate()
		} else if (newCommand) {
			camera.zoom = THREE.MathUtils.clamp(
				camera.zoom * (command.action === "in" ? 1.25 : 0.8),
				0.05,
				100,
			)
			camera.updateProjectionMatrix()
		}
		lastCommand.current = command.serial
		orbit.update()
		camera.updateMatrixWorld()
		const projectionKey = `${frameKey}:${selectedId}:${labelRevision}:${labels.current.size}:${camera.zoom}:${camera.matrixWorld.elements.join(",")}`
		if (lastProjection.current === projectionKey) return
		lastProjection.current = projectionKey
		// Declutter labels in screen space. The selected service wins every collision;
		// the full keyboard-accessible inventory stays available in the inspector.
		const related = connectedIds(topology, selectedId)
		const occupied = [...labels.current]
			.filter(([id]) => id.startsWith("overlay:"))
			.map(([, element]) => ({
				x: element.offsetLeft + element.offsetWidth / 2,
				y: element.offsetTop + element.offsetHeight / 2,
				width: element.offsetWidth,
				height: element.offsetHeight,
			}))
		const priority = (id: string) =>
			id === selectedId
				? 4
				: related?.has(id)
					? 3
					: nodesById.has(id)
						? nodesById.get(id)?.dimmed
							? 1
							: 2
						: linksById.has(id)
							? 0.5
							: 0
		const entries = [...labels.current]
			.sort(
				([a], [b]) =>
					priority(b) - priority(a) ||
					(nodesById.get(b)?.throughput ?? 0) - (nodesById.get(a)?.throughput ?? 0),
			)
			.map(([id, element]) => ({
				id,
				element,
				width: element.offsetWidth,
				height: element.offsetHeight,
			}))
		for (const { id, element, width, height } of entries) {
			const position = layout.positions.get(id)
			const link = linksById.get(id)
			const district = position
				? undefined
				: layout.districts.find((item) => `district:${item.id}` === id)
			if (position) probe.set(position[0], position[1], position[2] + 1.3)
			else if (district)
				probe.set(
					district.position[0] - district.width / 2 + 0.35,
					district.position[1],
					district.position[2] + district.depth / 2,
				)
			else if (link) probe.copy(link.signPosition)
			else continue
			probe.project(camera)
			const x = (probe.x * 0.5 + 0.5) * size.width
			const y = (-probe.y * 0.5 + 0.5) * size.height + (district ? 8 : link ? -height : 4)
			const hidden =
				(Boolean(position) && related !== null && !related.has(id)) ||
				probe.z < -1 ||
				probe.z > 1 ||
				x < 20 ||
				x > size.width - 20 ||
				y < 20 ||
				y > size.height - 25 ||
				occupied.some(
					(other) =>
						Math.abs(other.x - x) < (other.width + width) / 2 + 3 &&
						Math.abs(other.y - (y + height / 2)) < (other.height + height) / 2 + 2,
				)
			element.style.cssText = `transform:translate3d(${x}px,${y}px,0) translateX(-50%);visibility:${hidden ? "hidden" : "visible"};opacity:${element.style.opacity};background-color:${element.style.backgroundColor};color:${element.style.color}`
			if (!hidden) occupied.push({ x, y: y + height / 2, width, height })
		}
	})
	return null
}

const MOSS = 0.07
/** Between the meadow floor (-0.15) and the mats' base, so paths never fight either. */
const WORN_Y = -0.143

/** Cascade terraces are dry-stone retaining walls under a moss mat, with grass
 * drooping over the top edge so the cut sits naturally in the meadow. */
function StoneTerrace({ district, palette }: { district: District; palette: InkPalette }) {
	const [x, y, z] = district.position
	const { width, depth } = district
	const top = y + 0.16
	const body = top - MOSS - PLINTH_FLOOR
	const joints = useMemo(() => stoneCourses(district, body), [district, body])
	const fringe = useMemo(() => {
		const edge = top - MOSS
		const front = (s: number): Vec3 => [x + s, edge, z + depth / 2 + 0.03]
		const side = (s: number): Vec3 => [x + width / 2 + 0.03, edge, z + s]
		return [
			...grassFringe(width, front, [0, 0, 1], district.id),
			...grassFringe(depth, side, [1, 0, 0], district.id),
		]
	}, [district, x, z, width, depth, top])
	return (
		<group>
			<InkBox
				position={[x, PLINTH_FLOOR + body / 2, z]}
				size={[width, body, depth]}
				color={palette.stone}
				ink={palette.ink}
			/>
			<InkBox
				position={[x, top - MOSS / 2, z]}
				size={[width + 0.06, MOSS, depth + 0.06]}
				color={palette.plinth}
				ink={palette.ink}
			/>
			<InkLines points={joints} ink={fade(palette.ink, palette.stone, 0.45)} />
			<InkLines points={fringe} ink={palette.evergreen} />
		</group>
	)
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

function MeadowMat({ district, palette }: { district: District; palette: InkPalette }) {
	const [x, y, z] = district.position
	const top = y + 0.16
	// Built once; the caller keys MeadowMat on the zone's shape, so a moved zone remounts.
	const [{ faces, lines, tufts }] = useState(() => {
		const edge = meadowOutline(district)
		const faces = new THREE.ExtrudeGeometry(edge, { depth: top - PLINTH_FLOOR, bevelEnabled: false })
		// Shape y becomes world -z, extrusion becomes height.
		faces.rotateX(-Math.PI / 2).translate(x, PLINTH_FLOOR, z)
		shadeFaces(faces)
		const lines = new THREE.EdgesGeometry(faces, 35)
		const tufts = meadowTufts(edge, x, top, z, district.id)
		return { faces, lines, tufts }
	})
	useMountEffect(() => () => {
		faces.dispose()
		lines.dispose()
	})
	return (
		<group>
			<mesh
				geometry={faces}
				ref={(mesh) => {
					if (mesh) paintTurf(mesh.geometry, palette.plinth, palette.soil)
				}}
			>
				<PaperMaterial color="#ffffff" />
			</mesh>
			<InkOutline geometry={lines} ink={palette.ink} />
			<InkLines points={tufts} ink={palette.evergreen} />
		</group>
	)
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
function WornPaths({ links, palette }: { links: ReadonlyArray<FactoryLink>; palette: InkPalette }) {
	// Built once per mount; the parent keys this on route geometry, so metric
	// refreshes never rebuild or leak the mesh.
	const [geometry] = useState(() => {
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
		return paths
	})
	useMountEffect(() => () => geometry.dispose())
	const meadow = fade(palette.plinth, palette.paper, 0.4)
	return (
		<mesh geometry={geometry}>
			<meshBasicMaterial
				color={fade(palette.soil, meadow, 0.35)}
				side={THREE.DoubleSide}
				polygonOffset
				polygonOffsetFactor={1}
				polygonOffsetUnits={1}
			/>
		</mesh>
	)
}

/** Timber steps down the gap between neighbouring Cascade terraces. They sit at
 * the near end of the shared edge, past the outermost machine, where no belt runs. */
function TerraceSteps({ districts, palette }: { districts: ReadonlyArray<District>; palette: InkPalette }) {
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
			return (
				<InkBox
					key={`${upper.id}:${step}`}
					position={[from + tread * (step + 0.5), PLINTH_FLOOR + height / 2, z]}
					size={[tread, height, 0.5]}
					color={palette.kraft}
					ink={palette.ink}
				/>
			)
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

function MapScene(props: SceneProps) {
	const { topology, layout, links, view, selectedId, onSelect, palette, flowing } = props
	const related = connectedIds(topology, selectedId)
	return (
		<>
			<CameraRig {...props} />
			<Scenery key={view} layout={layout} belts={links} palette={palette} running={flowing} />
			{layout.districts.map((district) =>
				// Atlas zones are meadow mats; Cascade terraces rise to their depth.
				view === "cascade" ? (
					<StoneTerrace key={`${view}:${district.id}`} district={district} palette={palette} />
				) : (
					<MeadowMat
						key={`${view}:${district.id}:${district.position.join(",")}:${district.width}:${district.depth}`}
						district={district}
						palette={palette}
					/>
				),
			)}
			{view === "atlas" && (
				<WornPaths
					key={links.map((link) => link.geometryKey).join("|")}
					links={links}
					palette={palette}
				/>
			)}
			{view === "cascade" && (
				<TerraceSteps key={layout.districts.length} districts={layout.districts} palette={palette} />
			)}
			{links.map((link) => {
				const active = link.edge.source === selectedId || link.edge.target === selectedId
				return (
					<FactoryTransport
						key={JSON.stringify([
							view,
							palette.paper,
							link.id,
							link.geometryKey,
							link.edge.callsPerSecond,
							link.edge.avgLatencyMs,
							errorRateLevel(link.edge.errorRate),
						])}
						link={link}
						active={active}
						dimmed={Boolean(link.edge.dimmed) || (selectedId !== null && !active)}
						palette={palette}
						running={
							flowing &&
							!link.edge.dimmed &&
							link.edge.callsPerSecond > 0 &&
							(selectedId === null || active)
						}
					/>
				)
			})}
			{topology.nodes.map((node) => {
				const position = layout.positions.get(node.id)
				return (
					position && (
						<FactoryMachine
							key={`${view}:${node.id}`}
							node={node}
							position={position}
							view={view}
							dimmed={Boolean(node.dimmed) || (related !== null && !related.has(node.id))}
							selected={node.id === selectedId}
							palette={palette}
							running={flowing}
							onSelect={onSelect}
						/>
					)
				)
			})}
		</>
	)
}

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false }
	static getDerivedStateFromError() {
		return { failed: true }
	}
	render() {
		return this.state.failed ? (
			<div className="absolute inset-0 grid place-content-center gap-2 p-8 text-center text-sm">
				<p>3D rendering is unavailable.</p>
				<p className="text-muted-foreground">
					Use the service list to inspect connections, or reload to retry.
				</p>
			</div>
		) : (
			this.props.children
		)
	}
}

export function ServiceMap3D(props: SceneProps) {
	const pressed = useRef({ x: 0, y: 0 })
	return (
		<SceneBoundary>
			<Canvas
				orthographic
				flat
				dpr={[1, 2]}
				frameloop={props.flowing ? "always" : "demand"}
				gl={{ antialias: true, alpha: true }}
				onPointerDown={(event) => {
					pressed.current = { x: event.clientX, y: event.clientY }
				}}
				onPointerMissed={(event) => {
					// A pan that ends on empty paper keeps the current selection.
					const moved = Math.hypot(
						event.clientX - pressed.current.x,
						event.clientY - pressed.current.y,
					)
					if (moved <= DRAG_TOLERANCE) props.onSelect(null)
				}}
				style={{ position: "absolute", inset: 0 }}
			>
				<MapScene {...props} />
			</Canvas>
		</SceneBoundary>
	)
}
