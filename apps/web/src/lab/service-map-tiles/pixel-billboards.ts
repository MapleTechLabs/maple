import { Array as Arr, pipe, String as Str } from "effect"
import * as THREE from "three"
import { SPRITES, type SpriteName } from "./art/sprites.generated"
import { PX } from "./pixel-layout"

// Sprites standing in the 3D world. Each is a quad that grows from its foot and always faces
// the camera, lit by the map's own lights. Its shadow is the same sprite laid on the ground,
// thrown the way the sun or the moon throws it. A whole set is two meshes over one geometry.

/** One sprite and where its foot stands, in world units. */
export interface Bill {
	readonly sprite: SpriteName
	readonly at: readonly [number, number, number]
	/** Mirrored: the sprites are drawn facing right. */
	readonly flip?: boolean
	/** 0 to 1: how far it pales, for what has nothing to do with the selection. */
	readonly fade?: number
}

export interface Billboards {
	readonly mesh: THREE.Mesh
	/** The shadows on the ground. */
	readonly shade: THREE.Mesh
	readonly set: (bills: ReadonlyArray<Bill>) => void
	/** Throws the shadows `way` across the ground for each unit of height, `strength` dark (0 to 1). */
	readonly cast: (way: readonly [number, number], strength: number) => void
	readonly dispose: () => void
}

/** Corner offsets across and up from the foot, as shares of the sprite's width and height. */
const CORNERS: ReadonlyArray<readonly [number, number]> = [
	[-0.5, 0],
	[0.5, 0],
	[0.5, 1],
	[-0.5, 1],
]
const PALE = "vec3( 0.84, 0.84, 0.78 )"
/** What the ground writes to the stencil, so shadows know where it is. */
export const GROUND = 1

type Shader = Parameters<THREE.Material["onBeforeCompile"]>[0]

const HEAD = "#include <common>\nattribute vec2 corner;\nattribute float fade;"

/** Grows each quad out of its foot in view space, so it faces the camera. */
const standUp = (shader: Shader) => {
	const grown = Arr.join(
		[
			"vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );",
			"mvPosition.xy += corner;",
			"gl_Position = projectionMatrix * mvPosition;",
			"vFade = fade;",
		],
		"\n",
	)
	shader.vertexShader = pipe(
		shader.vertexShader,
		Str.replace("#include <common>", `${HEAD}\nvarying float vFade;`),
		Str.replace("#include <project_vertex>", grown),
	)
	shader.fragmentShader = pipe(
		shader.fragmentShader,
		Str.replace("#include <common>", "#include <common>\nvarying float vFade;"),
		Str.replace(
			"#include <map_fragment>",
			`#include <map_fragment>\ndiffuseColor.rgb = mix( diffuseColor.rgb, ${PALE}, vFade );`,
		),
	)
}

/** Lays each quad on the ground from where its foot's shadow falls, stretched the way `fall` points. */
const layDown = (shader: Shader, fall: { readonly value: THREE.Vector2 }) => {
	shader.uniforms.fall = fall
	const laid = Arr.join(
		[
			"vec2 side = normalize( vec2( - fall.y, fall.x ) );",
			"vec2 spot = transformed.xz + fall * ( transformed.y + corner.y ) + side * corner.x;",
			"vec4 mvPosition = modelViewMatrix * vec4( spot.x, 0.012, spot.y, 1.0 );",
			"gl_Position = projectionMatrix * mvPosition;",
		],
		"\n",
	)
	shader.vertexShader = pipe(
		shader.vertexShader,
		Str.replace("#include <common>", `${HEAD}\nuniform vec2 fall;`),
		Str.replace("#include <project_vertex>", laid),
	)
	// Only the sprite's outline counts: the shadow is one flat tone.
	shader.fragmentShader = pipe(
		shader.fragmentShader,
		Str.replace("#include <map_fragment>", "#include <map_fragment>\ndiffuseColor.rgb = diffuse;"),
	)
}

interface Buffers {
	readonly capacity: number
	readonly position: Float32Array
	readonly normal: Float32Array
	readonly uv: Float32Array
	readonly corner: Float32Array
	readonly fade: Float32Array
}

const allocate = (capacity: number): Buffers => ({
	capacity,
	position: new Float32Array(capacity * 12),
	// Lit as the ground is: every sprite's normal points straight up.
	normal: Float32Array.from({ length: capacity * 12 }, (_, index) => (index % 3 === 1 ? 1 : 0)),
	uv: new Float32Array(capacity * 8),
	corner: new Float32Array(capacity * 8),
	fade: new Float32Array(capacity * 4),
})

const geometryOf = (buffers: Buffers): THREE.BufferGeometry => {
	const geometry = new THREE.BufferGeometry()
	const dynamic = (array: Float32Array, size: number) =>
		new THREE.BufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage)
	geometry.setAttribute("position", dynamic(buffers.position, 3))
	geometry.setAttribute("normal", new THREE.BufferAttribute(buffers.normal, 3))
	geometry.setAttribute("uv", dynamic(buffers.uv, 2))
	geometry.setAttribute("corner", dynamic(buffers.corner, 2))
	geometry.setAttribute("fade", dynamic(buffers.fade, 1))
	geometry.setIndex(
		Arr.flatMap(Arr.range(0, buffers.capacity - 1), (quad) => {
			const first = quad * 4
			return [first, first + 1, first + 2, first, first + 2, first + 3]
		}),
	)
	geometry.setDrawRange(0, 0)
	return geometry
}

/** A set of sprites drawn from `atlas`, a sheet `sheet` pixels in size. */
export const makeBillboards = (
	atlas: THREE.Texture,
	sheet: { readonly width: number; readonly height: number },
	room = 256,
): Billboards => {
	const material = new THREE.MeshLambertMaterial({ map: atlas, alphaTest: 0.5, side: THREE.DoubleSide })
	material.onBeforeCompile = standUp
	const fall = { value: new THREE.Vector2(0.4, 0.6) }
	// A shadow falls only on the ground, and never twice on the same spot: the ground marks the
	// stencil with 1, and a shadow moves it on.
	const dark = new THREE.MeshBasicMaterial({
		map: atlas,
		// Below the faintest shadow's own opacity, or the whole of it would be cut away.
		alphaTest: 0.1,
		transparent: true,
		depthWrite: false,
		side: THREE.DoubleSide,
		stencilWrite: true,
		stencilFunc: THREE.EqualStencilFunc,
		stencilRef: GROUND,
		stencilZPass: THREE.IncrementStencilOp,
	})
	dark.color.setRGB(0.07, 0.06, 0.16)
	dark.onBeforeCompile = (shader) => layDown(shader, fall)
	const state = { buffers: allocate(room) }
	const mesh = new THREE.Mesh(geometryOf(state.buffers), material)
	const shade = new THREE.Mesh(mesh.geometry, dark)
	shade.renderOrder = -1
	// The quads are grown in the shader: their bounds on the CPU are only their feet.
	mesh.frustumCulled = false
	shade.frustumCulled = false
	return {
		mesh,
		shade,
		cast: (way, strength) => {
			fall.value.set(way[0], way[1])
			dark.opacity = strength
		},
		set: (bills) => {
			if (bills.length > state.buffers.capacity) {
				state.buffers = allocate(Math.max(bills.length, state.buffers.capacity * 2))
				mesh.geometry.dispose()
				mesh.geometry = geometryOf(state.buffers)
				shade.geometry = mesh.geometry
			}
			const { position, uv, corner, fade } = state.buffers
			Arr.forEach(bills, (bill, quad) => {
				const [sx, sy, w, h] = SPRITES[bill.sprite]
				// A hair inside the sprite's own pixels, so a neighbour on the sheet never shows.
				const [left, right] = [(sx + 0.02) / sheet.width, (sx + w - 0.02) / sheet.width]
				const [top, bottom] = [1 - (sy + 0.02) / sheet.height, 1 - (sy + h - 0.02) / sheet.height]
				Arr.forEach(CORNERS, ([across, up], index) => {
					const vertex = quad * 4 + index
					position.set(bill.at, vertex * 3)
					corner.set([(across * w) / PX, (up * h) / PX], vertex * 2)
					const isLeft = across < 0 !== (bill.flip === true)
					uv.set([isLeft ? left : right, up === 0 ? bottom : top], vertex * 2)
					fade[vertex] = bill.fade ?? 0
				})
			})
			const { attributes } = mesh.geometry
			Arr.forEach(["position", "uv", "corner", "fade"], (name) => {
				const attribute = attributes[name]
				if (attribute !== undefined) attribute.needsUpdate = true
			})
			mesh.geometry.setDrawRange(0, bills.length * 6)
		},
		dispose: () => {
			mesh.geometry.dispose()
			material.dispose()
			dark.dispose()
		},
	}
}
