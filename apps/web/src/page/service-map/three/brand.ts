import { fade, type InkPalette } from "../../../components/service-map/three/appearance"
import * as THREE from "three"
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js"
import type { MachineBadge } from "./badge-art"
import { type Child, group, inkBox, mesh, type Scope, type Vec3 } from "./kit"

/** Shared SVG artwork, including its knockouts, printed in ink on the sign. */
function badgeMark(_scope: Scope, { path, size, color }: { path: string; size: number; color: string }) {
	const svg = new SVGLoader().parse(
		`<svg xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="${path}" /></svg>`,
	)
	const mark = new THREE.ShapeGeometry(
		svg.paths.flatMap((svgPath) => svgPath.toShapes()),
		8,
	)
	mark.computeBoundingBox()
	const bounds = mark.boundingBox
	if (bounds) {
		const center = bounds.getCenter(new THREE.Vector3())
		const dimensions = bounds.getSize(new THREE.Vector3())
		const scale = size / Math.max(dimensions.x, dimensions.y)
		mark.translate(-center.x, -center.y, 0)
		mark.scale(scale, -scale, 1)
	}
	return mesh(mark, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }), {
		position: [0, 0, 0.032],
	})
}

function badgeWordmark(_scope: Scope, { text, color }: { text: string; color: string }): Child {
	const canvas = document.createElement("canvas")
	canvas.width = canvas.height = 256
	const context = canvas.getContext("2d")
	if (!context) return null
	context.fillStyle = "white"
	context.font = "bold 80px sans-serif"
	context.textAlign = "center"
	context.textBaseline = "middle"
	context.fillText(text, 128, 128, 224)
	const plane = new THREE.PlaneGeometry(0.7, 0.7)
	const map = new THREE.CanvasTexture(canvas)
	map.colorSpace = THREE.SRGBColorSpace
	return mesh(plane, new THREE.MeshBasicMaterial({ color, transparent: true, map }), {
		position: [0, 0, 0.032],
	})
}

export function factoryBadge(
	scope: Scope,
	{
		position,
		rotation,
		scale = 1,
		muted,
		badge,
		palette,
	}: {
		position: Vec3
		rotation: Vec3
		scale?: number
		muted: boolean
		badge: MachineBadge
		palette: InkPalette
	},
): THREE.Group {
	const color = muted ? fade(palette.ink, palette.paper, 0.72) : palette.ink
	const face = muted ? fade(palette.face, palette.paper, 0.72) : palette.face
	return group({ position, rotation, scale }, [
		inkBox({ size: [0.86, 0.86, 0.06], color: face, ink: color }),
		badge.wordmark
			? badgeWordmark(scope, { text: badge.wordmark, color })
			: badge.path
				? badgeMark(scope, { path: badge.path, size: 0.6, color })
				: null,
	])
}
