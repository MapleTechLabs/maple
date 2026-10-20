import type { MachineKind } from "../../../components/service-map/three/palette"
import { type Child, inkLines, type Scope, type Vec3 } from "./kit"
import { inkParts, type MapleFinish, type Part, range, variant } from "./props-kit"

/** A little sugar-bush worker in a plaid shirt and toque, holding a wrench or shouldering a log. */
export function worker(
	scope: Scope,
	{ position, holds, finish }: { position: Vec3; holds: "wrench" | "log"; finish: MapleFinish },
): Child {
	const [x, y, z] = position
	const at = (dx: number, dy: number, dz: number): Vec3 => [x + dx, y + dy, z + dz]
	const tool: Part[] =
		holds === "wrench"
			? [
					{ box: [0.022, 0.13, 0.022], at: at(0.09, 0.22, -0.06), turn: [-0.7, 0, 0] },
					{ box: [0.05, 0.03, 0.03], at: at(0.09, 0.27, -0.11), turn: [-0.7, 0, 0] },
				]
			: []
	return [
		inkParts(scope, {
			parts: [{ box: [0.1, 0.16, 0.07], at: at(0, 0.08, 0) }, ...tool],
			color: finish.iron,
			ink: finish.ink,
		}),
		inkParts(scope, {
			parts: [{ box: [0.13, 0.15, 0.09], at: at(0, 0.235, 0) }],
			color: finish.gifts[0] ?? finish.signal,
			ink: finish.ink,
		}),
		inkParts(scope, {
			parts: [{ box: [0.08, 0.08, 0.08], at: at(0, 0.35, 0) }],
			color: finish.tape,
			ink: finish.ink,
		}),
		inkParts(scope, {
			parts: [{ box: [0.09, 0.045, 0.09], at: at(0, 0.41, 0) }],
			color: finish.gifts[2] ?? finish.kraft,
			ink: finish.ink,
		}),
		holds === "log" &&
			inkParts(scope, {
				parts: [
					{ prism: [0.045, 0.045, 0.34, 8], at: at(0.085, 0.34, 0), turn: [Math.PI / 2, 0, 0] },
				],
				color: finish.kraft,
				ink: finish.ink,
			}),
	]
}

/** A red warning flag on a pole at the pad corner: this service is failing. */
function warningFlag(scope: Scope, { position, finish }: { position: Vec3; finish: MapleFinish }): Child {
	const [x, y, z] = position
	return [
		inkParts(scope, {
			parts: [
				{ prism: [0.018, 0.018, 0.9, 6], at: [x, y + 0.45, z] },
				{ box: [0.1, 0.05, 0.1], at: [x, y + 0.025, z] },
			],
			color: finish.timber,
			ink: finish.ink,
		}),
		inkParts(scope, {
			parts: [{ box: [0.26, 0.16, 0.012], at: [x - 0.14, y + 0.8, z] }],
			color: finish.gifts[0] ?? finish.signal,
			ink: finish.ink,
		}),
	]
}

/** Two planks nailed across a z-facing window. */
export function boardedWindow(
	scope: Scope,
	{ center, finish }: { center: Vec3; finish: MapleFinish },
): Child {
	const [x, y, z] = center
	return inkParts(scope, {
		parts: [-0.45, 0.45].map((lean, i): Part => ({
			box: [0.44, 0.06, 0.02],
			at: [x, y, z + 0.035 + i * 0.02],
			turn: [0, 0, lean],
		})),
		color: finish.timber,
		ink: finish.ink,
	})
}

/** Rope-and-lantern border round a selected pad, open at the midlines where belts come in. */
function lanternRing(scope: Scope, { finish }: { finish: MapleFinish }): Child {
	const [edge, near, rope] = [1.15, 0.7, 0.2]
	const corners = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => [sx * edge, sz * edge] as const))
	const posts = corners.flatMap(([cx, cz]) => [
		[cx, cz] as const,
		[Math.sign(cx) * near, cz] as const,
		[cx, Math.sign(cz) * near] as const,
	])
	// Each rope sags a little between its corner post and the post nearest the midline.
	const span = (a: readonly [number, number], b: readonly [number, number]) => {
		const mid = [(a[0] + b[0]) / 2, rope - 0.06, (a[1] + b[1]) / 2]
		return [a[0], rope, a[1], ...mid, ...mid, b[0], rope, b[1]]
	}
	const ropes = corners.flatMap(([cx, cz]) => [
		...span([cx, cz], [Math.sign(cx) * near, cz]),
		...span([cx, cz], [cx, Math.sign(cz) * near]),
	])
	return [
		inkParts(scope, {
			parts: posts.map(([x, z]): Part => ({ box: [0.05, 0.24, 0.05], at: [x, 0.12, z] })),
			color: finish.timber,
			ink: finish.ink,
		}),
		inkParts(scope, {
			parts: posts.map(([x, z]): Part => ({ box: [0.08, 0.09, 0.08], at: [x, 0.285, z] })),
			color: finish.glow,
			ink: finish.ink,
		}),
		inkLines(ropes, finish.ink),
	]
}

/** Where a visiting worker stands on each machine's pad, clear of belts and props. */
const WORKER_SPOT = {
	processor: [-0.5, 0, 1.0],
	tank: [-0.45, 0, 1.0],
	loader: [0.55, 0, 1.0],
	gateway: [-0.95, 0, 0.8],
	shed: [0.45, 0, 1.02],
} satisfies Record<MachineKind, Vec3>

/** Live state drawn as sugar-bush life: a worker fixing an elevated machine, a warning flag on a
 * degraded one, a woodcutter at a busy dock, and a lantern rope round the selection. */
export function mapleState(
	scope: Scope,
	{ kind, selected, finish }: { kind: MachineKind; selected: boolean; finish: MapleFinish },
): Child {
	return [
		finish.trouble === "elevated" &&
			worker(scope, { position: WORKER_SPOT[kind], holds: "wrench", finish }),
		finish.trouble === "degraded" && warningFlag(scope, { position: [0.98, 0, 1.0], finish }),
		kind === "loader" &&
			finish.activity >= 0.5 &&
			worker(scope, { position: [0.98, 0, -0.95], holds: "log", finish }),
		selected && lanternRing(scope, { finish }),
	]
}

const TONES = ["timber", "kraft", "iron", "soil", "moss", "pumpkin", "water", "linen", "paint"] as const
type Tone = (typeof TONES)[number]

/** A yard solid in local terms: `a` runs along the spot, `b` across it, y up. A prism may lie
 * along a or b instead of standing. */
type Bit = { tone: Tone; at: Vec3 } & (
	| { box: readonly [number, number, number] }
	| { prism: readonly [number, number, number, number]; lie?: "a" | "b" }
)

const box = (tone: Tone, size: readonly [number, number, number], at: Vec3): Bit => ({ tone, box: size, at })
const prism = (
	tone: Tone,
	size: readonly [number, number, number, number],
	at: Vec3,
	lie?: "a" | "b",
): Bit => ({
	tone,
	prism: size,
	at,
	lie,
})

/** Small homestead props, each about half a module long, built along `a`. */
const YARD_PROPS: ReadonlyArray<() => Bit[]> = [
	// Vegetable patch: a soil bed with three rows of greens.
	() => [
		box("soil", [0.5, 0.04, 0.3], [0, 0.02, 0]),
		...[-0.09, 0, 0.09].flatMap((b) =>
			[-0.18, -0.06, 0.06, 0.18].map((a) => box("moss", [0.06, 0.06, 0.06], [a, 0.07, b])),
		),
	],
	// Woodpile: two logs with one on top.
	() => [
		prism("kraft", [0.06, 0.06, 0.42, 8], [0, 0.06, -0.065], "a"),
		prism("kraft", [0.06, 0.06, 0.42, 8], [0, 0.06, 0.065], "a"),
		prism("kraft", [0.06, 0.06, 0.42, 8], [0, 0.165, 0], "a"),
	],
	// Rain barrel with two hoops and a dark water top.
	() => [
		prism("timber", [0.1, 0.1, 0.24, 8], [0, 0.12, 0]),
		prism("iron", [0.106, 0.106, 0.025, 8], [0, 0.05, 0]),
		prism("iron", [0.106, 0.106, 0.025, 8], [0, 0.19, 0]),
		prism("water", [0.085, 0.085, 0.006, 8], [0, 0.242, 0]),
	],
	// Bench, its back to the machine and its seat to the camera.
	() => [
		box("timber", [0.42, 0.03, 0.12], [0, 0.14, 0]),
		box("timber", [0.03, 0.13, 0.1], [-0.17, 0.065, 0]),
		box("timber", [0.03, 0.13, 0.1], [0.17, 0.065, 0]),
		box("timber", [0.42, 0.1, 0.02], [0, 0.24, -0.06]),
	],
	// Mailbox on a post.
	() => [
		box("timber", [0.04, 0.26, 0.04], [0, 0.13, 0]),
		box("paint", [0.17, 0.09, 0.09], [0, 0.3, 0]),
		box("iron", [0.015, 0.08, 0.015], [0.06, 0.37, 0.05]),
	],
	// Washing line between two posts, sheets pegged out.
	() => [
		box("timber", [0.035, 0.42, 0.035], [-0.26, 0.21, 0]),
		box("timber", [0.035, 0.42, 0.035], [0.26, 0.21, 0]),
		box("linen", [0.11, 0.13, 0.01], [-0.13, 0.33, 0]),
		box("paint", [0.09, 0.1, 0.01], [0, 0.345, 0]),
		box("linen", [0.11, 0.13, 0.01], [0.13, 0.33, 0]),
		box("iron", [0.52, 0.008, 0.008], [0, 0.4, 0]),
	],
	// Pumpkin pile, it is autumn.
	() => [
		prism("pumpkin", [0.075, 0.075, 0.09, 8], [-0.07, 0.045, 0]),
		prism("pumpkin", [0.06, 0.06, 0.075, 8], [0.08, 0.0375, 0.04]),
		prism("pumpkin", [0.065, 0.065, 0.08, 8], [0, 0.125, 0.01]),
		box("moss", [0.02, 0.04, 0.02], [0, 0.18, 0.01]),
	],
	// Hand cart with two wheels and shafts.
	() => [
		box("kraft", [0.32, 0.1, 0.22], [-0.04, 0.17, 0]),
		prism("iron", [0.085, 0.085, 0.03, 8], [-0.04, 0.085, -0.13], "b"),
		prism("iron", [0.085, 0.085, 0.03, 8], [-0.04, 0.085, 0.13], "b"),
		box("timber", [0.22, 0.025, 0.025], [0.22, 0.17, -0.08]),
		box("timber", [0.22, 0.025, 0.025], [0.22, 0.17, 0.08]),
	],
]

type Spot = { x: number; z: number; along: "x" | "z" }

/** Free pad corners per kind: off the belt midlines, clear of workers, flags, porches and the
 * selection posts, within |x|, |z| <= 1.2. */
const YARD_SPOTS = {
	processor: [
		{ x: -0.95, z: 1.0, along: "x" },
		{ x: -1.0, z: 0.4, along: "z" },
		{ x: -0.98, z: -0.42, along: "z" },
		{ x: 0.95, z: -0.95, along: "x" },
		{ x: 0.45, z: 0.98, along: "x" },
	],
	tank: [
		{ x: -0.95, z: 1.0, along: "x" },
		{ x: -1.0, z: 0.4, along: "z" },
		{ x: -0.98, z: -0.42, along: "z" },
		{ x: 0.95, z: -0.95, along: "x" },
		{ x: 0.45, z: 0.98, along: "x" },
	],
	loader: [
		{ x: -1.0, z: 0.4, along: "z" },
		{ x: -0.98, z: -0.42, along: "z" },
	],
	gateway: [
		{ x: -1.0, z: 0.4, along: "z" },
		{ x: -0.98, z: -0.42, along: "z" },
		{ x: 0.95, z: -0.95, along: "x" },
	],
	shed: [
		{ x: -0.95, z: 1.0, along: "x" },
		{ x: -1.0, z: 0.4, along: "z" },
		{ x: -0.98, z: -0.42, along: "z" },
		{ x: 0.95, z: -0.95, along: "x" },
	],
} satisfies Record<MachineKind, readonly Spot[]>

function placeBit(bit: Bit, { x, z, along }: Spot): Part {
	const [a, y, b] = bit.at
	const at: Vec3 = along === "x" ? [x + a, y, z + b] : [x + b, y, z + a]
	if ("box" in bit) {
		const [sa, h, sb] = bit.box
		return { box: along === "x" ? [sa, h, sb] : [sb, h, sa], at }
	}
	// A lying prism turns its axis onto world x or z, depending on how the spot runs.
	const axis = bit.lie === undefined ? undefined : (bit.lie === "a") === (along === "x") ? "x" : "z"
	const turn: Vec3 = axis === "x" ? [0, 0, Math.PI / 2] : axis === "z" ? [Math.PI / 2, 0, 0] : [0, 0, 0]
	return { prism: bit.prism, at, turn }
}

/** One or two seeded homestead props on the pad, one merged batch per colour. */
export function yard(scope: Scope, { kind, finish }: { kind: MachineKind; finish: MapleFinish }): Child {
	const spots: readonly Spot[] = YARD_SPOTS[kind]
	const count = Math.min(spots.length, 1 + variant(finish.seed, 20, 2))
	const first = variant(finish.seed, 21, spots.length)
	const bits = range(count).flatMap((i) => {
		const spot = spots[(first + i * (spots.length > 2 ? 2 : 1)) % spots.length]
		const make = YARD_PROPS[variant(finish.seed, 22 + i, YARD_PROPS.length)]
		return spot && make ? make().map((bit) => ({ tone: bit.tone, part: placeBit(bit, spot) })) : []
	})
	const tones = {
		timber: finish.timber,
		kraft: finish.kraft,
		iron: finish.iron,
		soil: finish.soil,
		moss: finish.moss,
		pumpkin: finish.gifts[1] ?? finish.kraft,
		water: finish.water,
		linen: finish.tape,
		paint: finish.gifts[0] ?? finish.signal,
	} satisfies Record<Tone, string>
	return TONES.map((tone) =>
		inkParts(scope, {
			parts: bits.filter((bit) => bit.tone === tone).map((bit) => bit.part),
			color: tones[tone],
			ink: finish.ink,
		}),
	)
}

/** The porchless door: stone steps up to the sill and a small shingled hood. */
export function doorSteps(scope: Scope, { door, finish }: { door: Vec3; finish: MapleFinish }): Child {
	const [x, y, z] = door
	const floor = y - 0.18
	return [
		inkParts(scope, {
			parts: [
				{ box: [0.14, floor - 0.004, 0.46], at: [x + 0.07, (floor - 0.004) / 2, z] },
				{ box: [0.12, floor / 2, 0.4], at: [x + 0.2, floor / 4, z] },
			],
			color: finish.stone,
			ink: finish.ink,
		}),
		inkParts(scope, {
			parts: [{ box: [0.16, 0.04, 0.56], at: [x + 0.07, y + 0.22, z], turn: [0, 0, -0.3] }],
			color: finish.shingle,
			ink: finish.ink,
		}),
	]
}

/** A planter under a z-facing window with three autumn blooms. */
export function flowerBox(
	scope: Scope,
	{ position, finish }: { position: Vec3; finish: MapleFinish },
): Child {
	const [x, y, z] = position
	return [
		inkParts(scope, {
			parts: [{ box: [0.42, 0.1, 0.12], at: [x, y, z + 0.06] }],
			color: finish.timber,
			ink: finish.ink,
		}),
		[-0.14, 0, 0.14].map((dx, i) =>
			inkParts(scope, {
				parts: [{ box: [0.08, 0.08, 0.08], at: [x + dx, y + 0.1, z + 0.06] }],
				color: finish.gifts[(i + 1) % finish.gifts.length] ?? finish.face,
				ink: finish.ink,
			}),
		),
	]
}
