import { Color } from "three"
import { errorRateLevel } from "@maple/ui/lib/error-rate"

/** WebGL colors in sRGB. The map is isometric line art: unlit paper faces in
 * three fixed tones, outlined in ink. Health is a small signal on each machine. */
export const GROUND_Y = -0.02

export type MapStyle = "drafted" | "whimsy" | "maple"
export type MachineKind = "processor" | "tank" | "loader" | "gateway" | "shed"

export interface InkPalette {
	style: MapStyle
	paper: string
	dots: string
	face: string
	plinth: string
	/** The slab each machine stands on. */
	pad: string
	ink: string
	belt: string
	kraft: string
	tape: string
	selected: string
	/** Body paint per machine kind. Drafted keeps every machine paper-white. */
	tint: Record<MachineKind, string>
	/** Accent colours: gift wrap in Whimsy, autumn leaves in Maple; Drafted ships plain kraft. */
	gifts: readonly string[]
	foliage: readonly string[]
	/** Evergreens that stay green through the Maple autumn. */
	evergreen: string
	/** Material accents shared by props and scenery. */
	stone: string
	iron: string
	soil: string
	birch: string
	water: string
	/** Warm light: lantern panes, lit windows at night. */
	glow: string
	trunk: string
	cloud: string
	/** HTML sign plate and its lettering, picked for contrast in each theme. */
	sign: string
	signInk: string
}

/** Resolved colours for one machine, already faded when the machine is dimmed. */
export interface MachineFinish {
	face: string
	ink: string
	signal: string
	kraft: string
	tape: string
	glass: string
	hazard: string
	style: MapStyle
	gifts: readonly string[]
	/** Decorative motion (smoke, pinwheels) follows the traffic toggle. */
	running: boolean
}

const plain = (face: string) => ({ processor: face, tank: face, loader: face, gateway: face, shed: face })

const DRAFTED = {
	light: {
		style: "drafted",
		paper: "#f0f2ec",
		dots: "#2f4a3b24",
		face: "#fbfcf8",
		plinth: "#e4e8dd",
		pad: "#e4e8dd",
		ink: "#2f4a3b",
		belt: "#e9ece4",
		kraft: "#d8ad6c",
		tape: "#f6eedc",
		selected: "#d9a21b",
		tint: plain("#fbfcf8"),
		gifts: ["#d8ad6c"],
		foliage: [],
		trunk: "#94703c",
		evergreen: "#fbfcf8",
		cloud: "#fbfcf8",
		stone: "#fbfcf8",
		iron: "#2f4a3b",
		soil: "#e4e8dd",
		birch: "#fbfcf8",
		water: "#e9ece4",
		glow: "#d9a21b",
		sign: "#f6eedc",
		signInk: "#2f4a3b",
	},
	dark: {
		style: "drafted",
		paper: "#161c18",
		dots: "#b9cbbf1f",
		face: "#26302a",
		plinth: "#1d2520",
		pad: "#1d2520",
		ink: "#b9cbbf",
		belt: "#212a24",
		kraft: "#b88d52",
		tape: "#e2d4b4",
		selected: "#d9a21b",
		tint: plain("#26302a"),
		gifts: ["#b88d52"],
		foliage: [],
		trunk: "#94703c",
		evergreen: "#26302a",
		cloud: "#26302a",
		stone: "#26302a",
		iron: "#b9cbbf",
		soil: "#1d2520",
		birch: "#26302a",
		water: "#212a24",
		glow: "#d9a21b",
		sign: "#2b3530",
		signInk: "#dfe8e1",
	},
} satisfies Record<"light" | "dark", InkPalette>

/** Storybook pastels on warm cream, drawn in plum ink. */
const WHIMSY = {
	light: {
		style: "whimsy",
		paper: "#fbf3e4",
		dots: "#4a3b5c1f",
		face: "#fffaf1",
		plinth: "#dcefc9",
		pad: "#f4e4cf",
		ink: "#4a3b5c",
		belt: "#f4e4cf",
		kraft: "#e8b07a",
		tape: "#fff6de",
		selected: "#f2b632",
		tint: {
			processor: "#ffd9cc",
			tank: "#cce9f6",
			loader: "#fde9ad",
			gateway: "#ddd3f7",
			shed: "#d0eedb",
		},
		gifts: ["#ff9fb2", "#9fd3f5", "#ffd27f", "#b6e3a1", "#c9b5ff"],
		foliage: ["#9fd39a", "#b5e2a0", "#86c79a", "#f7b9cb"],
		trunk: "#b07d54",
		evergreen: "#86c79a",
		cloud: "#ffffff",
		stone: "#ece6f2",
		iron: "#4a3b5c",
		soil: "#ecd0b0",
		birch: "#ffffff",
		water: "#a9dcf0",
		glow: "#ffe08a",
		sign: "#fff6de",
		signInk: "#4a3b5c",
	},
	dark: {
		style: "whimsy",
		paper: "#1e1a29",
		dots: "#e9dcff1c",
		face: "#3a3250",
		plinth: "#263a2f",
		pad: "#2c2640",
		ink: "#eadfff",
		belt: "#2c2640",
		kraft: "#b9895c",
		tape: "#efe2c4",
		selected: "#f2b632",
		tint: {
			processor: "#7c5862",
			tank: "#48677c",
			loader: "#7c6b3f",
			gateway: "#5e5384",
			shed: "#4b6f59",
		},
		gifts: ["#d97a8f", "#6fa6c8", "#d6a55a", "#86b574", "#9a86d1"],
		foliage: ["#5f9a62", "#78a867", "#4f8a63", "#c27f96"],
		trunk: "#8a6043",
		evergreen: "#4f8a63",
		cloud: "#4a4163",
		stone: "#4a4163",
		iron: "#1e1a29",
		soil: "#5a4636",
		birch: "#d8d0e8",
		water: "#3d6a80",
		glow: "#ffd36b",
		sign: "#3a3250",
		signInk: "#f6efff",
	},
} satisfies Record<"light" | "dark", InkPalette>

/** An autumn sugar-bush: timber cabins on moss, maple reds and Maple's own amber,
 * bark ink. Night swaps parchment for a blue-green forest lit by warm windows. */
const MAPLE = {
	light: {
		style: "maple",
		paper: "#f4eddc",
		dots: "#4a35251c",
		face: "#fbf5e8",
		plinth: "#c4d095",
		pad: "#e6d6b4",
		ink: "#4a3525",
		belt: "#e2c899",
		kraft: "#c99a62",
		tape: "#f6ead0",
		selected: "#e86f00",
		tint: {
			processor: "#f0d4a8",
			tank: "#d9a774",
			loader: "#e8cfa0",
			gateway: "#ddd2bd",
			shed: "#c99466",
		},
		gifts: ["#c8442f", "#e86f00", "#e9a23b", "#a8532a", "#d97a2b"],
		foliage: ["#c8442f", "#e86f00", "#e9a23b", "#b5532d", "#d97a2b"],
		trunk: "#6e4a32",
		evergreen: "#5b7f4f",
		cloud: "#fbf5e8",
		stone: "#cbc4b6",
		iron: "#5a5048",
		soil: "#b08560",
		birch: "#f3efe6",
		water: "#9cc6cc",
		glow: "#ffc56b",
		sign: "#f6ead0",
		signInk: "#4a3525",
	},
	dark: {
		style: "maple",
		paper: "#111a1a",
		dots: "#cfe3d816",
		face: "#2c3430",
		plinth: "#24382c",
		pad: "#2b2d25",
		ink: "#e6dcc4",
		belt: "#3d3025",
		kraft: "#8f6a42",
		tape: "#e6d3ad",
		selected: "#ff8a1f",
		tint: {
			processor: "#5f4b36",
			tank: "#6a4a33",
			loader: "#5e5038",
			gateway: "#4c4f48",
			shed: "#5c4230",
		},
		gifts: ["#b8432f", "#d9680a", "#c98f35", "#94502c", "#c06d2a"],
		foliage: ["#a63d2c", "#c9620e", "#b98632", "#8a4a2a", "#b0662a"],
		trunk: "#4f3726",
		evergreen: "#2f4a3a",
		cloud: "#24302e",
		stone: "#4a504b",
		iron: "#212725",
		soil: "#3d2f25",
		birch: "#c6c9bf",
		water: "#21424a",
		glow: "#ffb347",
		sign: "#3a2a1e",
		signInk: "#f2e2c2",
	},
} satisfies Record<"light" | "dark", InkPalette>

const PALETTES = { drafted: DRAFTED, whimsy: WHIMSY, maple: MAPLE } as const

export function mapPalette(style: MapStyle, dark: boolean): InkPalette {
	return PALETTES[style][dark ? "dark" : "light"]
}

/** Face tones for a camera on the (+x, +y, +z) diagonal: roofs stay lit, the
 * two visible walls step down. Matches hand-drawn isometric shading. */
export const FACE_TONE = { top: 1, front: 0.93, side: 0.85, hidden: 0.8 } as const

/** Mix toward the paper so dimmed parts recede without transparency sorting. */
export function fade(color: string, paper: string, amount: number) {
	return `#${new Color(color).lerp(new Color(paper), amount).getHexString()}`
}

export function beltInk(errorRate: number, palette: InkPalette) {
	const level = errorRateLevel(errorRate)
	return level === "crit" ? "#c8553d" : level === "warn" ? "#d9a21b" : palette.ink
}

/** Paper with a faint dot grid, theme-aware like the rest of the chrome. */
export function paperBackground(palette: InkPalette) {
	return {
		backgroundColor: palette.paper,
		backgroundImage: `radial-gradient(${palette.dots} 1px, transparent 1.2px)`,
		backgroundSize: "18px 18px",
	} as const
}
