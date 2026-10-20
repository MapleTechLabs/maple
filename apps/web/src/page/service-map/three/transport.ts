import { errorRateLevel } from "@maple/ui/lib/error-rate"
import { beltInk, fade, type InkPalette } from "../../../components/service-map/three/appearance"
import { beltGeometry, type FactoryLink } from "../../../components/service-map/three/factory-routing"
import * as THREE from "three"
import {
	type Child,
	group,
	inkBox,
	inkLines,
	inkSolid,
	mesh,
	type Running,
	type Scope,
	shadeFaces,
} from "./kit"
import { factoryMotion } from "./motion"

interface TransportProps {
	readonly link: FactoryLink
	readonly running: Running
	readonly active: boolean
	readonly dimmed: boolean
	readonly palette: InkPalette
}

/** A canvas texture built once per scope under `key`. */
function cachedTexture(scope: Scope, key: string, build: () => THREE.Texture) {
	const cached = scope.textures.get(key)
	if (cached) return cached
	const texture = build()
	scope.textures.set(key, texture)
	return texture
}

function paintTexture(width: number, height: number, draw: (context: CanvasRenderingContext2D) => void) {
	const canvas = document.createElement("canvas")
	canvas.width = width
	canvas.height = height
	const context = canvas.getContext("2d")
	if (context) draw(context)
	const texture = new THREE.CanvasTexture(canvas)
	texture.colorSpace = THREE.SRGBColorSpace
	return texture
}

/** A slatted wooden crate face with an ink border, shared by every crate. */
function parcelTexture(scope: Scope, palette: InkPalette) {
	return cachedTexture(scope, `parcel:${palette.kraft}:${palette.ink}`, () => {
		const texture = paintTexture(64, 64, (context) => {
			context.fillStyle = palette.kraft
			context.fillRect(0, 0, 64, 64)
			context.strokeStyle = palette.ink
			context.lineWidth = 2.5
			for (const y of [21, 43]) {
				context.beginPath()
				context.moveTo(0, y)
				context.lineTo(64, y)
				context.stroke()
			}
			context.strokeStyle = palette.ink
			context.lineWidth = 5
			context.strokeRect(2.5, 2.5, 59, 59)
		})
		texture.anisotropy = 4
		return texture
	})
}

/** Belts are timber boardwalks: plank seams across the deck, stringers along it and
 * posts every so often. Flumes also get a raised side wall. One line draw; each
 * vertex carries a weight (1 timber, 0 plank seam) that becomes its colour. */
function boardwalkLines(curve: THREE.Curve<THREE.Vector3>, width: number, flume: boolean, broken: boolean) {
	const points: number[] = [],
		weights: number[] = []
	const length = curve.getLength()
	const at = (raw: number, offset: number, lift = 0) => {
		// Crack strokes reach past a seam; three throws on samples outside [0, 1].
		const t = THREE.MathUtils.clamp(raw, 0, 1)
		const point = curve.getPointAt(t)
		const tangent = curve.getTangentAt(t)
		const side = new THREE.Vector3(tangent.z, 0, -tangent.x).normalize()
		return point.setY(point.y + 0.004 + lift).addScaledVector(side, offset)
	}
	const stroke = (a: THREE.Vector3, b: THREE.Vector3, weight: number) => {
		points.push(...a.toArray(), ...b.toArray())
		weights.push(weight, weight)
	}
	const wall = 0.075
	const half = width / 2
	const rails = flume ? [-half, half] : [-half, -half + 0.05, half - 0.05, half]
	const samples = Math.max(24, Math.ceil(length / 0.12))
	for (const offset of rails)
		for (let i = 0; i < samples; i++) {
			stroke(at(i / samples, offset), at((i + 1) / samples, offset), 1)
			if (flume && Math.abs(offset) === half)
				stroke(at(i / samples, offset, wall), at((i + 1) / samples, offset, wall), 1)
		}
	const planks = Math.floor(length / 0.12)
	// A failing belt shows split planks: every eighth seam becomes a rail-tinted crack.
	for (let i = 1; i < planks; i++) {
		if (!broken || i % 8 !== 4) {
			stroke(at(i / planks, -half), at(i / planks, half), 0)
			continue
		}
		const step = 0.35 / length
		const crack = [at(i / planks - step, -half), at(i / planks + step, -half / 3)]
		crack.push(at(i / planks - step, half / 3), at(i / planks + step, half))
		crack.slice(1).forEach((point, k) => stroke(crack[k] ?? point, point, 1))
	}
	const posts = Math.max(2, Math.round(length / 0.9))
	for (let i = 0; i <= posts; i++)
		for (const offset of [-half, half])
			stroke(at(i / posts, offset), at(i / posts, offset, flume ? wall : 0.05), 1)
	return { points, weights }
}

function parcelGeometry(size: readonly [number, number, number], phases: Float32Array) {
	const [w, h, d] = size
	const box = shadeFaces(new THREE.BoxGeometry(w, h, d))
	box.setAttribute("factoryPhase", new THREE.InstancedBufferAttribute(phases, 1))
	return box
}

/** A tapered octagonal sap bucket, flat-shaded per facet like the tanks. Its
 * groups stay: 0 is the staved side, 1 and 2 the sap surface and base. */
function bucketGeometry(size: number, phases: Float32Array) {
	const height = size * 0.9
	const bucket = new THREE.CylinderGeometry(size * 0.5, size * 0.4, height, 8).toNonIndexed()
	bucket.computeVertexNormals()
	bucket.setAttribute("factoryPhase", new THREE.InstancedBufferAttribute(phases, 1))
	// Motion lifts parcels by half the crate size; sit the shorter bucket on the deck.
	return shadeFaces(bucket.translate(0, (height - size) / 2, 0))
}

/** Eight staves with two iron hoops, wrapped once around the bucket. */
function bucketTexture(scope: Scope, palette: InkPalette) {
	return cachedTexture(scope, `bucket:${palette.stone}:${palette.ink}`, () =>
		paintTexture(128, 32, (context) => {
			context.fillStyle = palette.stone
			context.fillRect(0, 0, 128, 32)
			context.fillStyle = palette.ink
			for (let x = 0; x < 128; x += 16) context.fillRect(x, 0, 1.5, 32)
			for (const y of [5, 23]) context.fillRect(0, y, 128, 3)
			context.fillRect(0, 0, 128, 2)
			context.fillRect(0, 30, 128, 2)
		}),
	)
}

/** Bark for the log's side and growth rings for its cut ends, outlined in ink. */
function logTextures(scope: Scope, palette: InkPalette) {
	const key = `${palette.trunk}:${palette.kraft}:${palette.ink}`
	// Side UVs wrap the circumference on u, so constant-u grooves run along the log.
	const bark = cachedTexture(scope, `log-bark:${key}`, () =>
		paintTexture(128, 32, (context) => {
			context.fillStyle = palette.trunk
			context.fillRect(0, 0, 128, 32)
			context.fillStyle = palette.ink
			for (let x = 4; x < 128; x += 11) context.fillRect(x, 3 + (x % 7), 1.5, 22 - (x % 5))
			context.fillRect(0, 0, 128, 2.5)
			context.fillRect(0, 29.5, 128, 2.5)
		}),
	)
	const grain = cachedTexture(scope, `log-grain:${key}`, () =>
		paintTexture(64, 64, (context) => {
			context.fillStyle = palette.kraft
			context.fillRect(0, 0, 64, 64)
			context.strokeStyle = palette.ink
			for (const [radius, width] of [
				[29, 4],
				[19, 1.5],
				[10, 1.5],
				[3, 1.5],
			] as const) {
				context.lineWidth = width
				context.beginPath()
				context.arc(32, 32, radius, 0, Math.PI * 2)
				context.stroke()
			}
		}),
	)
	return [bark, grain] as const
}

/** A log rolling crosswise on the belt: its axis runs across the deck (local x),
 * and it rests on the deck although the motion shader lifts every cargo by `lift`. */
function logGeometry(size: number, lift: number, phases: Float32Array) {
	const radius = size * 0.34
	const log = new THREE.CylinderGeometry(radius, radius, size * 1.45, 10)
	log.rotateZ(Math.PI / 2)
	log.translate(0, radius - lift, 0)
	shadeFaces(log)
	log.setAttribute("factoryPhase", new THREE.InstancedBufferAttribute(phases, 1))
	return log
}

/** Cargo per belt: denser on longer and busier belts, so traffic reads as a
 * working line rather than a few boxes. */
export function cargoCount(length: number, callsPerSecond: number) {
	const busy = THREE.MathUtils.clamp(Math.log10(callsPerSecond + 1) / 3, 0, 1)
	return Math.round(THREE.MathUtils.clamp(length * (0.55 + busy * 0.9), 3, 44))
}

/** Which cargo rides in each slot: crates, with logs and sap buckets mixed in. */
function cargoKind(index: number) {
	return index % 5 === 1 || index % 5 === 3 ? "log" : index % 5 === 4 ? "bucket" : "crate"
}

function instanced(
	geometry: THREE.BufferGeometry,
	material: THREE.Material | Array<THREE.Material>,
	count: number,
) {
	const cargo = new THREE.InstancedMesh(geometry, material, count)
	cargo.frustumCulled = false
	return cargo
}

function parcels(
	scope: Scope,
	{
		link,
		running,
		size,
		palette,
	}: { link: FactoryLink; running: Running; size: number; palette: InkPalette },
): THREE.Group {
	const count = cargoCount(link.curve.getLength(), link.edge.callsPerSecond)
	const period = Math.max(3, link.curve.getLength() / 1.4) + link.edge.avgLatencyMs / 400
	const motion = factoryMotion(scope, link, running, count, period, size / 2, true)
	// Each slot on the shared timetable carries one kind of cargo.
	const all = [...motion.phases]
	const of = (kind: ReturnType<typeof cargoKind>) =>
		Float32Array.from(all.filter((_, i) => cargoKind(i) === kind))
	const crates = of("crate"),
		logs = of("log"),
		buckets = of("bucket")
	const box = parcelGeometry([size, size, size], crates)
	const bucket = bucketGeometry(size, buckets)
	const log = logGeometry(size, size / 2, logs)
	const [bark, grain] = logTextures(scope, palette)
	const { onBeforeCompile, customProgramCacheKey } = motion.material
	// Staves, an amber sap surface, and the base; all ride the shared motion shader.
	const bucketPaint = [
		{ map: bucketTexture(scope, palette) },
		{ color: new THREE.Color(palette.glow) },
		{ color: new THREE.Color(palette.stone) },
	].map((paint) =>
		Object.assign(new THREE.MeshBasicMaterial({ ...paint, vertexColors: true }), {
			onBeforeCompile,
			customProgramCacheKey,
		}),
	)
	// Cylinder groups: 0 is the bark side, 1 and 2 the cut ends.
	const logPaint = [{ map: bark }, { map: grain }, { map: grain }].map((paint) =>
		Object.assign(new THREE.MeshBasicMaterial({ ...paint, vertexColors: true }), {
			onBeforeCompile,
			customProgramCacheKey,
		}),
	)
	const crate = Object.assign(
		new THREE.MeshBasicMaterial({ map: parcelTexture(scope, palette), vertexColors: true }),
		{ onBeforeCompile, customProgramCacheKey },
	)
	return group({}, [
		instanced(box, crate, crates.length),
		buckets.length > 0 && instanced(bucket, bucketPaint, buckets.length),
		logs.length > 0 && instanced(log, logPaint, logs.length),
	])
}

/** A level, straight 1.2 unit stretch of belt, if the route has one. */
function straightStretch(curve: THREE.Curve<THREE.Vector3>) {
	const span = 1.2 / curve.getLength()
	for (const t of [0.3, 0.7, 0.2, 0.8]) {
		if (t - span / 2 < 0.05 || t + span / 2 > 0.95) continue
		const a = curve.getTangentAt(t - span / 2),
			b = curve.getTangentAt(t + span / 2)
		if (a.dot(b) > 0.999 && Math.abs(a.y) < 0.01) return { point: curve.getPointAt(t), tangent: a }
	}
	return null
}

/** A short covered bridge: a shingled pitched roof on four posts over the planks. */
function coveredSpan(
	_scope: Scope,
	{
		curve,
		width,
		ink,
		roof,
	}: { curve: THREE.Curve<THREE.Vector3>; width: number; ink: string; roof: string },
): Child {
	const stretch = straightStretch(curve)
	const r = (width + 0.24) / Math.sqrt(3)
	const prism = new THREE.CylinderGeometry(r, r, 1.2, 3, 1, false, Math.PI / 2)
		.rotateZ(Math.PI / 2)
		.scale(1, 0.6, 1)
	if (!stretch) return null
	const { point, tangent } = stretch
	const eave = 0.55
	const base = -0.3 * r,
		ridge = 0.6 * r,
		half = (r * Math.sqrt(3)) / 2
	const lift = eave - base
	const z = width / 2 + 0.04
	const posts = [-0.5, 0.5].flatMap((x) => [-z, z].flatMap((side) => [x, 0, side, x, eave, side]))
	const shingles = [1 / 3, 2 / 3].flatMap((f) =>
		[-1, 1].flatMap((side) => {
			const y = lift + base + (ridge - base) * f
			return [-0.6, y, side * half * (1 - f), 0.6, y, side * half * (1 - f)]
		}),
	)
	return group(
		{
			position: [point.x, point.y + 0.004, point.z],
			rotation: [0, Math.atan2(-tangent.z, tangent.x), 0],
		},
		[
			inkLines(posts, ink),
			inkSolid({ geometry: prism, position: [0, lift, 0], color: roof, ink }),
			inkLines(shingles, ink),
		],
	)
}

/** A lantern post on the outside of one elbow, its lamp hung back over the turn. */
function lanternPost(
	_scope: Scope,
	{
		link,
		width,
		seed,
		palette,
		recede,
	}: {
		link: FactoryLink
		width: number
		seed: number
		palette: InkPalette
		recede: (color: string) => string
	},
): Child {
	const elbows = link.curve.curves.filter((curve) => curve instanceof THREE.QuadraticBezierCurve3)
	const elbow = elbows[seed % Math.max(1, elbows.length)]
	if (!elbow) return null
	const inside = elbow.v0.clone().add(elbow.v2).multiplyScalar(0.5)
	const out = elbow.v1.clone().sub(inside).setY(0).normalize()
	const foot = elbow.v1.clone().addScaledVector(out, width / 2 + 0.14)
	const arm = foot.clone().addScaledVector(out, -0.2)
	const top = foot.y + 0.78
	return group({}, [
		inkBox({
			position: [foot.x, foot.y + 0.39, foot.z],
			size: [0.05, 0.78, 0.05],
			color: recede(palette.trunk),
			ink: recede(palette.ink),
		}),
		inkLines(
			[foot.x, top, foot.z, arm.x, top, arm.z, arm.x, top, arm.z, arm.x, top - 0.06, arm.z],
			recede(palette.ink),
		),
		inkBox({
			position: [arm.x, top - 0.12, arm.z],
			size: [0.1, 0.12, 0.1],
			color: recede(palette.glow),
			ink: recede(palette.ink),
		}),
	])
}

/** Deck width: queue conveyors are wide, call belts swell with traffic. */
function beltWidth(link: FactoryLink) {
	return link.kind === "conveyor" ? 0.72 : 0.3 + link.radius * 1.4
}

/** A stable 0..996 number per link, for rare seeded dressing. */
export function linkSeed(id: string) {
	let seed = 11
	for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) % 997
	return seed
}

/** Plank seams sit halfway between ink and deck so the timber reads first. */
function paintBoardwalk(
	geometry: THREE.BufferGeometry,
	weights: ReadonlyArray<number>,
	rail: string,
	deck: string,
) {
	const colors = geometry.getAttribute("color")
	const railTone = new THREE.Color(rail)
	const seam = railTone.clone().lerp(new THREE.Color(deck), 0.55)
	weights.forEach((weight, i) => {
		const tone = weight === 1 ? railTone : seam
		colors.setXYZ(i, tone.r, tone.g, tone.b)
	})
	colors.needsUpdate = true
}

export function factoryTransport(
	scope: Scope,
	{ link, running, active, dimmed, palette }: TransportProps,
): THREE.Group {
	const width = beltWidth(link)
	// Rare seeded dressing keeps long boardwalks from repeating.
	const seed = linkSeed(link.id)
	const deck = beltGeometry(link.curve, width)
	const broken = errorRateLevel(link.edge.errorRate) !== "neutral"
	const lines = new THREE.BufferGeometry()
	const { points, weights } = boardwalkLines(link.curve, width, link.kind === "pipe", broken)
	lines.setAttribute("position", new THREE.Float32BufferAttribute(points, 3))
	lines.setAttribute("color", new THREE.Float32BufferAttribute(weights.length * 3, 3))
	const ink = beltInk(link.edge.errorRate, palette)
	const recede = (color: string) => (dimmed ? fade(color, palette.paper, 0.8) : color)
	// A selected service's boardwalks light up in warm timber with amber rails;
	// error tints still win over the amber.
	const deckColor = recede(active ? palette.kraft : palette.belt)
	const railColor = active && ink === palette.ink ? palette.selected : ink
	const deckMesh = mesh(
		deck,
		new THREE.MeshBasicMaterial({
			color: deckColor,
			side: THREE.DoubleSide,
			polygonOffset: true,
			polygonOffsetFactor: 1,
			polygonOffsetUnits: 1,
		}),
	)
	const boardwalk = new THREE.LineSegments(
		lines,
		new THREE.LineBasicMaterial({ color: "#ffffff", vertexColors: true }),
	)
	paintBoardwalk(lines, weights, recede(railColor), deckColor)
	return group({}, [
		deckMesh,
		boardwalk,
		seed % 6 === 0 &&
			link.curve.getLength() > 7 &&
			coveredSpan(scope, {
				curve: link.curve,
				width,
				ink: recede(ink),
				roof: recede(palette.gifts[0] ?? palette.trunk),
			}),
		seed % 5 === 2 && lanternPost(scope, { link, width, seed, palette, recede }),
		link.edge.callsPerSecond > 0 &&
			!dimmed &&
			parcels(scope, {
				link,
				running,
				size: link.kind === "conveyor" ? 0.42 : Math.max(0.22, width * 0.62),
				palette,
			}),
	])
}
