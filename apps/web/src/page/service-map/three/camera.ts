import { connectedIds, type SpatialView } from "../../../components/service-map/three/spatial-layout"
import type { Topology3D } from "../../../components/service-map/three/types"
import * as THREE from "three"
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import type { Vec3 } from "./kit"
import type { Layout } from "./world"

// The camera rig. The camera and HTML labels share
// one projection; labels are the `[data-scene-label]` elements under the scene root.

export interface CameraCommand {
	readonly action: "reset" | "in" | "out"
	readonly serial: number
}

export interface RigInput {
	readonly topology: Topology3D
	readonly layout: Layout
	readonly view: SpatialView
	readonly selectedId: string | null
	readonly command: CameraCommand
}

export interface Size {
	readonly width: number
	readonly height: number
}

const vector = (p: Vec3) => new THREE.Vector3(...p)
/** 2:1 isometric, the pixel-art convention: 45° azimuth, about 30° elevation. */
const ISOMETRIC = new THREE.Vector3(1, Math.SQRT2 * Math.tan(Math.PI / 6), 1).normalize().multiplyScalar(40)
/** Frame a little meadow around the zones, so a small topology still shows the
 * forest edge on reset without shrinking a large map much. */
const FRAME_MARGIN = 2.5

const LABEL_ATTRIBUTE = "data-scene-label"

const boundsOf = (layout: Layout["layout"]) => {
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
	for (const point of layout.positions.values()) points.push(vector(point).add(new THREE.Vector3(0, 4, 0)))
	return { points, center: new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3()) }
}

/** What CameraRig memoizes per input: rebuilt when the topology, layout or links change. */
const derive = (input: RigInput) => ({
	input,
	linksById: new Map(input.layout.links.map((link) => [link.id, link])),
	nodesById: new Map(input.topology.nodes.map((node) => [node.id, node])),
	labelRevision: JSON.stringify([
		input.topology.nodes.map((node) => [node.id, node.label, node.throughput, node.dimmed]),
		input.layout.links.map((link) => [link.id, link.edge.callsPerSecond]),
	]),
	layoutKey: JSON.stringify([...input.layout.layout.positions]),
	bounds: boundsOf(input.layout.layout),
})

/** The rig's frame: refit on a new frame key or reset, zoom on a command, then place labels. */
export const cameraRig = (
	camera: THREE.OrthographicCamera,
	orbit: OrbitControls,
	labelsRoot: Element,
	read: () => RigInput,
	size: () => Size,
	invalidate: () => void,
): (() => void) => {
	const state = { lastFrame: "", lastCommand: -1, lastProjection: "", memo: derive(read()) }
	const probe = new THREE.Vector3()
	return () => {
		const input = read()
		if (state.memo.input.topology !== input.topology || state.memo.input.layout !== input.layout)
			state.memo = derive(input)
		const { bounds, layoutKey, linksById, nodesById, labelRevision } = state.memo
		const { view, command, selectedId, topology } = input
		const { layout } = input.layout
		const { width, height } = size()
		const frameKey = `${view}:${width}:${height}:${layoutKey}`
		const newCommand = state.lastCommand !== command.serial
		if (state.lastFrame !== frameKey || (newCommand && command.action === "reset")) {
			state.lastFrame = frameKey
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
			const framing = width < 600 ? 1.6 : 1.75
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
		state.lastCommand = command.serial
		orbit.update()
		camera.updateMatrixWorld()
		const labels = [...labelsRoot.querySelectorAll(`[${LABEL_ATTRIBUTE}]`)].flatMap((element) =>
			element instanceof HTMLElement
				? [[element.getAttribute(LABEL_ATTRIBUTE) ?? "", element] as const]
				: [],
		)
		const projectionKey = `${frameKey}:${selectedId}:${labelRevision}:${labels.length}:${camera.zoom}:${camera.matrixWorld.elements.join(",")}`
		if (state.lastProjection === projectionKey) return
		state.lastProjection = projectionKey
		projectLabels({
			camera,
			probe,
			labels,
			topology,
			layout,
			selectedId,
			linksById,
			nodesById,
			width,
			height,
		})
	}
}

type Memo = ReturnType<typeof derive>

/** Declutter labels in screen space. The selected service wins every collision, namespace
 * signs outrank rate tags; the full keyboard-accessible inventory stays in the inspector. */
const projectLabels = ({
	camera,
	probe,
	labels,
	topology,
	layout,
	selectedId,
	linksById,
	nodesById,
	width: sizeWidth,
	height: sizeHeight,
}: {
	camera: THREE.OrthographicCamera
	probe: THREE.Vector3
	labels: ReadonlyArray<readonly [string, HTMLElement]>
	topology: Topology3D
	layout: Layout["layout"]
	selectedId: string | null
	linksById: Memo["linksById"]
	nodesById: Memo["nodesById"]
	width: number
	height: number
}) => {
	const related = connectedIds(topology, selectedId)
	const occupied = labels
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
					: id.startsWith("district:")
						? 1.5
						: linksById.has(id)
							? 0.5
							: 0
	const entries = labels
		.toSorted(
			([a], [b]) =>
				priority(b) - priority(a) ||
				(nodesById.get(b)?.throughput ?? 0) - (nodesById.get(a)?.throughput ?? 0),
		)
		.map(([id, element]) => ({ id, element, width: element.offsetWidth, height: element.offsetHeight }))
	for (const { id, element, width, height } of entries) {
		const position = layout.positions.get(id)
		const link = linksById.get(id)
		const district = position ? undefined : layout.districts.find((item) => `district:${item.id}` === id)
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
		const x = (probe.x * 0.5 + 0.5) * sizeWidth
		const y = (-probe.y * 0.5 + 0.5) * sizeHeight + (district ? 8 : link ? -height : 4)
		const hidden =
			(Boolean(position) && related !== null && !related.has(id)) ||
			probe.z < -1 ||
			probe.z > 1 ||
			x < 20 ||
			x > sizeWidth - 20 ||
			y < 20 ||
			y > sizeHeight - 25 ||
			occupied.some(
				(other) =>
					Math.abs(other.x - x) < (other.width + width) / 2 + 6 &&
					Math.abs(other.y - (y + height / 2)) < (other.height + height) / 2 + 4,
			)
		element.style.cssText = `transform:translate3d(${x}px,${y}px,0) translateX(-50%);visibility:${hidden ? "hidden" : "visible"};opacity:${element.style.opacity};background-color:${element.style.backgroundColor};color:${element.style.color}`
		if (!hidden) occupied.push({ x, y: y + height / 2, width, height })
	}
}
