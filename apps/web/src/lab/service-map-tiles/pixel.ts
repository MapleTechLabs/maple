import { Schema } from "effect"
import * as THREE from "three"

// The pixel-art look. The scene is drawn small, with no smoothing, and blown up so every drawn
// pixel is a square block on screen. On the way its colours are made more vivid and snapped to a
// few steps a channel, which turns soft shading into flat bands the way a limited palette does,
// and whatever stands in front of something further away gets a dark outline one pixel wide.

/** How the map is drawn: the inked, painted look, or pixel art. */
export const ArtStyle = Schema.Literals(["painted", "pixel"])
export type ArtStyle = typeof ArtStyle.Type

/** How many CSS pixels wide one drawn pixel is. */
const BLOCK = 2
/** Steps of colour per channel after snapping. */
const STEPS = 12
/** How much more saturated the picture is made, and how much more contrast it is given. */
const VIVID = 1.22
const CONTRAST = 1.06
/** How big a step in depth, as a share of the distance, counts as an edge to outline. */
const EDGE = 0.0035

/** The outline's colour: a dark plum, as pixel art outlines in. */
const OUTLINE = "#2b1f2e"

export interface PixelPass {
	/** Sizes the small picture for a canvas `width` by `height` device pixels at `ratio`. */
	readonly resize: (width: number, height: number, ratio: number) => void
	readonly render: (scene: THREE.Scene, camera: THREE.PerspectiveCamera) => void
	readonly dispose: () => void
}

const VERTEX = /* glsl */ `
void main() {
	gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

// The small picture holds linear, premultiplied colour. It is graded as the eye sees it (so the
// steps are even to look at), then handed back linear for three to encode for the screen.
const FRAGMENT = /* glsl */ `
#include <packing>
uniform sampler2D frame;
uniform sampler2D depths;
uniform vec2 texel;
uniform vec2 pixel;
uniform float near;
uniform float far;
uniform float steps;
uniform float vivid;
uniform float contrast;
uniform float edge;
uniform vec3 outline;

// How far from the eye the surface drawn at a point of the small picture is.
float distanceAt(vec2 uv) {
	return -perspectiveDepthToViewZ(texture2D(depths, uv).x, near, far);
}

void main() {
	vec2 uv = gl_FragCoord.xy * texel;
	vec4 drawn = texture2D(frame, uv);
	vec3 straight = drawn.a > 0.0 ? min(drawn.rgb / drawn.a, vec3(1.0)) : vec3(0.0);
	vec3 seen = pow(max(straight, 0.0), vec3(1.0 / 2.2));
	float grey = dot(seen, vec3(0.299, 0.587, 0.114));
	seen = mix(vec3(grey), seen, vivid);
	seen = (seen - 0.5) * contrast + 0.5;
	seen = floor(clamp(seen, 0.0, 1.0) * steps + 0.5) / steps;
	// A slope gets steadily further away and is left alone; a jump to something behind is an
	// edge, and the nearer side of it is inked.
	float here = distanceAt(uv);
	float around = distanceAt(uv + vec2(pixel.x, 0.0)) + distanceAt(uv - vec2(pixel.x, 0.0))
		+ distanceAt(uv + vec2(0.0, pixel.y)) + distanceAt(uv - vec2(0.0, pixel.y));
	float inked = step(edge * here, around - 4.0 * here) * drawn.a;
	seen = mix(seen, outline, inked * 0.82);
	gl_FragColor = vec4(pow(seen, vec3(2.2)) * drawn.a, drawn.a);
	#include <colorspace_fragment>
}
`

export const makePixelPass = (renderer: THREE.WebGLRenderer): PixelPass => {
	// Half floats keep the dark end of a night scene from banding before it is graded.
	const target = new THREE.WebGLRenderTarget(1, 1, {
		minFilter: THREE.NearestFilter,
		magFilter: THREE.NearestFilter,
		type: THREE.HalfFloatType,
		depthBuffer: true,
		depthTexture: new THREE.DepthTexture(1, 1),
	})
	const texel = new THREE.Vector2(1, 1)
	const pixel = new THREE.Vector2(1, 1)
	const material = new THREE.ShaderMaterial({
		uniforms: {
			frame: { value: target.texture },
			depths: { value: target.depthTexture },
			texel: { value: texel },
			pixel: { value: pixel },
			near: { value: 1 },
			far: { value: 2000 },
			edge: { value: EDGE },
			outline: { value: new THREE.Color(OUTLINE).convertLinearToSRGB() },
			steps: { value: STEPS },
			vivid: { value: VIVID },
			contrast: { value: CONTRAST },
		},
		vertexShader: VERTEX,
		fragmentShader: FRAGMENT,
		depthTest: false,
		depthWrite: false,
		blending: THREE.NoBlending,
	})
	const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
	quad.frustumCulled = false
	const stage = new THREE.Scene()
	stage.add(quad)
	const lens = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
	return {
		resize: (width, height, ratio) => {
			// Whole device pixels per block, so every block is the same size on screen.
			const block = Math.max(1, Math.round(BLOCK * ratio))
			const columns = Math.max(1, Math.ceil(width / block))
			const rows = Math.max(1, Math.ceil(height / block))
			target.setSize(columns, rows)
			texel.set(1 / (columns * block), 1 / (rows * block))
			pixel.set(1 / columns, 1 / rows)
		},
		render: (scene, camera) => {
			material.uniforms.near = { value: camera.near }
			material.uniforms.far = { value: camera.far }
			renderer.setRenderTarget(target)
			renderer.render(scene, camera)
			renderer.setRenderTarget(null)
			renderer.render(stage, lens)
		},
		dispose: () => {
			target.dispose()
			material.dispose()
			quad.geometry.dispose()
		},
	}
}
