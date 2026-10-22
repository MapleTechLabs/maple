import { fade, type InkPalette, type MachineKind } from "../../../components/service-map/three/appearance"
import { health, HEALTH_COLOR, type SpatialView } from "../../../components/service-map/three/spatial-layout"
import type { Node3D } from "../../../components/service-map/three/types"
import * as THREE from "three"
import { resolveMachineBadge } from "./badge-art"
import { factoryBadge } from "./brand"
import { lantern, logPile, mapleTap, toadstools } from "./decor"
import {
	type Child,
	group,
	inkBox,
	inkLines,
	inkPlate,
	inkSolid,
	type Running,
	type Scope,
	type Vec3,
} from "./kit"
import {
	boardedWindow,
	choppingStump,
	doorSteps,
	eaves,
	flowerBox,
	gableRoof,
	GATE_MARK,
	inkParts,
	logWalls,
	mapleGate,
	mapleState,
	type MapleFinish,
	type Pane,
	type Part,
	porch,
	seedOf,
	stoneChimney,
	stoneCourse,
	stovepipe,
	sugarRoof,
	variant,
	vatHoops,
	windowDressing,
	woodSled,
	yard,
} from "./props"

/** One stacked crate module. Machines are 2×2 modules wide and grow in whole storeys. */
export const MODULE = 0.8
const HALF = MODULE

/** Machines need stone, iron and timber colours beyond the shared finish. */
type Finish = MapleFinish

/** Request volume as 0 to 1 on a log scale (0.1 rps to 1000 rps); exactly idle stays 0. */
function machineActivity(throughput: number) {
	if (!(throughput > 0)) return 0
	return Math.min(1, Math.max(0.08, (Math.log10(throughput) + 1) / 4))
}

/** Request volume adds storeys: 1 below 10 rps, up to 4 for the busiest services. */
export function machineStoreys(node: Pick<Node3D, "throughput">, view: SpatialView) {
	if (view === "cascade") return 2
	return Math.min(4, 1 + Math.floor(Math.log10(Math.max(1, node.throughput)) * 0.9))
}

/** The cabins' stone footing, which lifts their doors onto a porch. */
const FOOTING = 0.14

const range = (count: number) => Array.from({ length: Math.max(0, count) }, (_, i) => i)

/** Horizontal slats across a rectangle on an x- or z-facing wall. */
function louvre(center: Vec3, normal: "x" | "z", width: number, height: number, slats: number) {
	const [x, y, z] = center
	return range(slats).flatMap((i) => {
		const sy = y - height / 2 + ((i + 1) * height) / (slats + 1)
		return normal === "x"
			? [x, sy, z - width / 2, x, sy, z + width / 2]
			: [x - width / 2, sy, z, x + width / 2, sy, z]
	})
}

/** A cross mullion splitting a window into four panes. */
function mullion(center: Vec3, normal: "x" | "z", width: number, height: number) {
	const [x, y, z] = center
	return normal === "x"
		? [x, y - height / 2, z, x, y + height / 2, z, x, y, z - width / 2, x, y, z + width / 2]
		: [x, y - height / 2, z, x, y + height / 2, z, x - width / 2, y, z, x + width / 2, y, z]
}

/** Clapboard siding on the two visible walls of a 2×2-module body. */
function clapboard(height: number) {
	return range(Math.floor(height / 0.16)).flatMap((i) => {
		const y = (i + 1) * 0.16
		return [
			-HALF,
			y,
			HALF + 0.001,
			HALF + 0.001,
			y,
			HALF + 0.001,
			HALF + 0.001,
			y,
			HALF + 0.001,
			HALF + 0.001,
			y,
			-HALF,
		]
	})
}

/** A valve handwheel standing upright, facing the camera's front wall. */
function wheel([x, y, z]: Vec3, radius: number) {
	return range(10).flatMap((i) => {
		const a = (i * Math.PI) / 5,
			b = ((i + 1) * Math.PI) / 5
		return [
			x + radius * Math.cos(a),
			y + radius * Math.sin(a),
			z,
			x + radius * Math.cos(b),
			y + radius * Math.sin(b),
			z,
		]
	})
}

function windowPane(
	_scope: Scope,
	{ center, normal, finish }: { center: Vec3; normal: "x" | "z"; finish: Finish },
): Child {
	return [
		inkPlate({ size: [0.34, 0.26], position: center, normal, color: finish.glass, ink: finish.ink }),
		inkLines(mullion(center, normal, 0.34, 0.26), finish.ink),
	]
}

/** Health is the painted door on the machine's lit side wall, reached by a porch or steps. */
function door(scope: Scope, { position, finish }: { position: Vec3; finish: Finish }) {
	const [x, y, z] = position
	// Lantern panes are gifts[2]; a degraded machine's lamp is out.
	const lamp =
		finish.trouble === "degraded"
			? { ...finish, gifts: finish.gifts.map((c, i) => (i === 2 ? finish.iron : c)) }
			: finish
	return group({}, [
		inkPlate({ size: [0.42, 0.36], position, normal: "x", color: finish.signal, ink: finish.ink }),
		inkLines([x, y - 0.18, z, x, y + 0.18, z, x, y + 0.02, z - 0.13, x, y - 0.02, z - 0.13], finish.ink),
		variant(finish.seed, 4, 3) === 0
			? doorSteps(scope, { door: position, finish })
			: porch(scope, { door: position, finish }),
		lantern(scope, { position: [x, y, z - 0.33], finish: lamp }),
	])
}

function processor(scope: Scope, { height, finish }: { height: number; finish: Finish }) {
	const storeys = Math.round(height / MODULE)
	const badgeStorey = Math.min(storeys, 2) - 1
	// The chimney and stovepipe swap back corners per cabin.
	const flip = variant(finish.seed, 3, 2) === 1
	const sides = variant(finish.seed, 9, 3)
	// The badge storey skips its left front window; the ground storey's side wall has the door.
	const panes = range(storeys).flatMap((storey) => {
		const y = storey * MODULE + MODULE * 0.55
		const pane = (center: Vec3, normal: "x" | "z"): Pane => ({ center, normal })
		return [
			pane([0.4, y, HALF + 0.002], "z"),
			...(storey !== badgeStorey ? [pane([-0.4, y, HALF + 0.002], "z")] : []),
			...(storey > 0 ? [pane([HALF + 0.002, y, 0.4], "x"), pane([HALF + 0.002, y, -0.4], "x")] : []),
		].filter(
			// Cabins vary the side wall: both windows, or only the front or back one.
			({ center, normal }) => normal === "z" || sides === 0 || (sides === 1) === center[2] > 0,
		)
	})
	const front = panes[0]
	return group({}, [
		inkBox({
			size: [HALF * 2, height, HALF * 2],
			position: [0, height / 2, 0],
			color: finish.face,
			ink: finish.ink,
			cell: MODULE,
		}),
		panes.map((pane) => windowPane(scope, { center: pane.center, normal: pane.normal, finish })),
		stoneCourse(scope, { half: HALF, height: FOOTING, finish }),
		windowDressing(scope, { windows: panes, finish }),
		finish.trouble === "degraded" && front && boardedWindow(scope, { center: front.center, finish }),
		variant(finish.seed, 6, 2) === 1 &&
			front &&
			flowerBox(scope, { position: [front.center[0], front.center[1] - 0.2, HALF], finish }),
		eaves(scope, { half: HALF, top: height, finish }),
		inkPlate({
			size: [0.42, 0.3],
			position: [HALF + 0.002, 0.42, -0.4],
			normal: "x",
			color: finish.face,
			ink: finish.ink,
		}),
		inkLines(louvre([HALF + 0.003, 0.42, -0.4], "x", 0.42, 0.3, 4), finish.ink),
		inkBox({
			size: [0.06, height, 0.06],
			position: [HALF + 0.03, height / 2, HALF + 0.03],
			color: finish.face,
			ink: finish.ink,
		}),
		stoneChimney(scope, { base: [flip ? 0.42 : -0.42, height, -0.42], height: 0.6, width: 0.26, finish }),
		stovepipe(scope, { position: [flip ? -0.38 : 0.36, height, -0.38], finish }),
		door(scope, { position: [HALF + 0.002, FOOTING + 0.18, 0.36], finish }),
		inkLines(clapboard(height), finish.ink),
	])
}

function storageTank(scope: Scope, { height, finish }: { height: number; finish: Finish }) {
	const body = new THREE.CylinderGeometry(0.82, 0.82, height, 8)
	const hoops = range(Math.round(height / MODULE) * 2 - 1).map((i) => (i + 1) * (MODULE / 2))
	// Coopers differ: hoops every half storey, every storey, or doubled bands.
	const hoopStyle = variant(finish.seed, 10, 3)
	const vatHoopHeights =
		hoopStyle === 1
			? hoops.filter((_, i) => i % 2 === 1)
			: hoopStyle === 2
				? hoops.flatMap((y) => [y - 0.045, y + 0.045])
				: hoops
	// The ladder climbs the facet that faces the isometric camera.
	const facing = new THREE.Vector3(1, 0, 1).normalize().multiplyScalar(0.79)
	const across = new THREE.Vector3(1, 0, -1).normalize().multiplyScalar(0.11)
	const rails = [-1, 1].flatMap((side) => [
		facing.x + across.x * side,
		0.06,
		facing.z + across.z * side,
		facing.x + across.x * side,
		height + 0.12,
		facing.z + across.z * side,
	])
	const rungs = range(Math.floor(height / 0.16)).flatMap((i) => [
		facing.x - across.x,
		0.14 + i * 0.16,
		facing.z - across.z,
		facing.x + across.x,
		0.14 + i * 0.16,
		facing.z + across.z,
	])
	return group({}, [
		group({ rotation: [0, Math.PI / 8, 0] }, [
			inkSolid({ geometry: body, position: [0, height / 2, 0], color: finish.face, ink: finish.ink }),
		]),
		vatHoops(scope, { heights: [0.16, ...vatHoopHeights, height - 0.06], finish }),
		sugarRoof(scope, { height, finish }),
		inkLines([...rails, ...rungs], finish.ink),
		mapleTap(scope, { position: [0.76, height * 0.6, -0.12], finish }),
		inkBox({
			size: [0.5, 0.12, 0.12],
			position: [0.95, 0.2, -0.42],
			color: finish.face,
			ink: finish.ink,
		}),
		inkBox({
			size: [0.06, 0.24, 0.24],
			position: [1.12, 0.2, -0.42],
			color: finish.face,
			ink: finish.ink,
		}),
		inkLines([0.95, 0.26, -0.42, 0.95, 0.4, -0.42, ...wheel([0.95, 0.46, -0.42], 0.1)], finish.ink),
		inkBox({
			size: [0.36, 0.4, 0.32],
			position: [0.82, 0.2, 0.2],
			color: finish.signal,
			ink: finish.ink,
		}),
	])
}

function loadingBay(scope: Scope, { height, finish }: { height: number; finish: Finish }) {
	const gantry = height + 0.3
	const rollers = range(10).flatMap((i) => [-0.85, 0.302, -0.48 + i * 0.14, 0.85, 0.302, -0.48 + i * 0.14])
	return group({}, [
		inkBox({ size: [1.7, 0.3, 1.7], position: [0, 0.15, 0], color: finish.face, ink: finish.ink }),
		inkLines(rollers, finish.ink),
		inkPlate({
			size: [1.7, 0.1],
			position: [0, 0.23, 0.851],
			normal: "z",
			color: finish.timber,
			ink: finish.ink,
		}),
		choppingStump(scope, { position: [0.68, 0.3, -0.36], finish }),
		woodSled(scope, { position: [-0.52, 0, 1.02], finish }),
		[0, 1].map((step) =>
			inkBox({
				size: [0.18, 0.1 * (2 - step), 0.5],
				position: [0.94 + step * 0.18, 0.05 * (2 - step), 0.4],
				color: finish.face,
				ink: finish.ink,
			}),
		),
		[-0.72, 0.72].map((x) =>
			inkBox({
				size: [0.18, gantry, 0.18],
				position: [x, gantry / 2, -0.7],
				color: finish.face,
				ink: finish.ink,
			}),
		),
		inkBox({ size: [1.8, 0.24, 0.3], position: [0, gantry, -0.7], color: finish.face, ink: finish.ink }),
		inkPlate({
			size: [0.5, 0.14],
			position: [0, gantry, -0.549],
			normal: "z",
			color: finish.signal,
			ink: finish.ink,
		}),
		group({ position: [-0.32, gantry - 0.12, -0.5] }, [
			inkBox({ size: [0.26, 0.14, 0.2], position: [0, -0.07, 0], color: finish.face, ink: finish.ink }),
			inkLines([-0.04, -0.14, 0, -0.04, -0.62, 0, 0.04, -0.14, 0, 0.04, -0.62, 0], finish.ink),
			inkBox({
				size: [0.16, 0.1, 0.1],
				position: [0, -0.67, 0],
				color: finish.hazard,
				ink: finish.ink,
			}),
		]),
		inkBox({ size: [1.36, 0.08, 0.7], position: [0, 0.34, 0.25], color: finish.kraft, ink: finish.ink }),
		logPile(scope, { finish, base: 0.38 }),
	])
}

/** An open timber gate over a stepping-stone path, with a striped barrier arm out front. */
function gateway(scope: Scope, { height, finish }: { height: number; finish: Finish }) {
	const posts = Math.max(MODULE, height - 0.5)
	const stripe = finish.gifts[0] ?? finish.hazard
	return group({}, [
		mapleGate(scope, { posts, finish }),
		inkParts(scope, {
			parts: range(3).map((i): Part => ({
				box: [0.26, 0.03, 0.2],
				at: [i % 2 === 0 ? -0.05 : 0.06, 0.015, -0.6 + i * 0.5],
			})),
			color: finish.stone,
			ink: finish.ink,
		}),
		group({ position: [0.5, 0, 1.0] }, [
			inkBox({ size: [0.18, 0.42, 0.18], position: [0, 0.21, 0], color: finish.face, ink: finish.ink }),
			range(4).map((i) =>
				inkBox({
					size: [0.24, 0.07, 0.07],
					position: [-0.21 - i * 0.24, 0.36, 0],
					color: i % 2 === 0 ? stripe : finish.face,
					ink: finish.ink,
				}),
			),
		]),
	])
}

/** A log cabin with an outside stone chimney, for services beyond the map. */
function shed(scope: Scope, { height, finish }: { height: number; finish: Finish }) {
	const walls = Math.max(MODULE, height - 0.4)
	// Log walls stand proud of the body, so the window and door sit on the logs' outer face.
	const face = 0.862
	const pane: Pane = { center: [0.4, walls * 0.55, face], normal: "z" }
	return group({}, [
		inkBox({
			size: [HALF * 2, walls, HALF * 2],
			position: [0, walls / 2, 0],
			color: finish.tape,
			ink: finish.ink,
		}),
		logWalls(scope, { walls, finish }),
		gableRoof(scope, { base: walls, half: HALF + 0.08, rise: 0.62, length: HALF * 2 + 0.1, finish }),
		windowPane(scope, { center: pane.center, normal: "z", finish }),
		windowDressing(scope, { windows: [pane], finish }),
		finish.trouble === "degraded" && boardedWindow(scope, { center: pane.center, finish }),
		inkBox({
			size: [0.3, 0.5, 0.42],
			position: [1.01, 0.25, -0.42],
			color: finish.stone,
			ink: finish.ink,
			cell: 0.13,
		}),
		stoneChimney(scope, { base: [0.99, 0.5, -0.42], height: walls + 0.4, width: 0.24, finish }),
		toadstools(scope, { position: [-0.55, -0.06, 0.95], finish }),
		door(scope, { position: [face, 0.26, 0.36], finish }),
	])
}

function machineKind(node: Node3D): MachineKind {
	if (node.kind === "database") return "tank"
	if (node.kind === "queue" || node.id.endsWith("worker")) return "loader"
	if (node.kind === "external") return "shed"
	if (node.kind === "edge" || node.platform === "cloudflare") return "gateway"
	return "processor"
}

const MACHINE_MODELS = {
	processor,
	tank: storageTank,
	loader: loadingBay,
	gateway,
	shed,
} satisfies Record<MachineKind, (scope: Scope, props: { height: number; finish: Finish }) => THREE.Object3D>

/** Service marks hang on the front wall, facing the isometric camera. */
function badgeMount(kind: MachineKind, height: number): { position: Vec3; rotation: Vec3; scale?: number } {
	switch (kind) {
		case "tank":
			return { position: [0, height + 0.301, 0], rotation: [-Math.PI / 2, 0, 0], scale: 0.6 }
		case "loader":
			return { position: [0.6, height + 0.3, -0.54], rotation: [0, 0, 0], scale: 0.32 }
		case "gateway":
			// The open gate carries its mark on the header board above the passage.
			return {
				position: [0, Math.max(MODULE, height - 0.5) + GATE_MARK.y, GATE_MARK.z],
				rotation: [0, 0, 0],
				scale: 0.5,
			}
		default:
			return {
				// Sheds wear log walls, so their mark hangs on the logs' outer face.
				position: [-0.36, Math.min(height, MODULE * 2) - 0.42, kind === "shed" ? 0.885 : HALF + 0.03],
				rotation: [0, 0, 0],
				scale: 0.5,
			}
	}
}

/** One machine on its pad; the outer group carries `userData.pickId` for the scene's raycast. */
export function factoryMachine(
	scope: Scope,
	{
		node,
		position,
		view,
		dimmed,
		selected,
		palette,
		running,
	}: {
		node: Node3D
		position: Vec3
		view: SpatialView
		dimmed: boolean
		selected: boolean
		palette: InkPalette
		running: Running
	},
): THREE.Group {
	const kind = machineKind(node)
	const badge = resolveMachineBadge(node)
	const height = machineStoreys(node, view) * MODULE
	const recede = (color: string) => (dimmed ? fade(color, palette.paper, 0.72) : color)
	const trouble = health(node.errorRate)
	// Each homestead draws its roof and shutters from earthy sets, stable per node.
	const seed = seedOf(node.id)
	const slate = fade(palette.stone, palette.iron, 0.45)
	const roofs = [palette.foliage[3], palette.foliage[0], slate, palette.evergreen, palette.trunk]
	const shutters = [palette.evergreen, palette.foliage[0], palette.trunk, palette.foliage[2]]
	const finish: Finish = {
		face: recede(palette.tint[kind]),
		ink: recede(palette.ink),
		signal: recede(HEALTH_COLOR[trouble]),
		kraft: recede(palette.kraft),
		tape: recede(palette.tape),
		// Windows are lamplit, and go dark when the service is degraded.
		glass: recede(
			trouble === "degraded"
				? fade(palette.ink, palette.face, 0.45)
				: fade(palette.glow, palette.face, 0.3),
		),
		hazard: recede(palette.selected),
		gifts: palette.gifts.map(recede),
		running: () => running() && !dimmed,
		stone: recede(palette.stone),
		iron: recede(palette.iron),
		glow: recede(palette.glow),
		timber: recede(palette.trunk),
		shingle: recede(roofs[variant(seed, 1, roofs.length)] ?? palette.trunk),
		shutter: recede(shutters[variant(seed, 2, shutters.length)] ?? palette.evergreen),
		activity: machineActivity(node.throughput),
		trouble,
		seed,
		soil: recede(palette.soil),
		water: recede(palette.water),
		moss: recede(palette.evergreen),
	}
	const model = MACHINE_MODELS[kind]
	const machine = group({ position }, [
		inkBox({
			size: [2.5, 0.06, 2.5],
			position: [0, 0.03, 0],
			color: selected ? palette.selected : recede(palette.pad),
			ink: finish.ink,
		}),
		group({ position: [0, 0.06, 0] }, [
			model(scope, { height, finish }),
			mapleState(scope, { kind, selected, finish }),
			yard(scope, { kind, finish }),
			badge && factoryBadge(scope, { ...badgeMount(kind, height), muted: dimmed, badge, palette }),
		]),
	])
	machine.userData.pickId = node.id
	return machine
}
