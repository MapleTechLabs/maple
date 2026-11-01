// The palette half of `appearance.ts`, without three, so DOM chrome can read it.

/** WebGL colors in sRGB. The map is isometric line art: unlit paper faces in
 * three fixed tones, outlined in ink. Health is a small signal on each machine. */
export type MachineKind = "processor" | "tank" | "loader" | "gateway" | "shed"

export interface InkPalette {
	/** Dark theme: windows and lamps read as lit against a night scene. */
	night: boolean
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
	/** Body paint per machine kind. */
	tint: Record<MachineKind, string>
	/** Autumn accent colours, kept off the health and selection hues so status reads first. */
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
	gifts: readonly string[]
	/** Decorative motion (smoke, pinwheels) follows the traffic toggle. */
	running: boolean
}

/** An autumn sugar-bush: timber cabins on moss, maple reds and Maple's own amber,
 * bark ink. Night swaps parchment for a blue-green forest lit by warm windows. */
const MAPLE = {
	light: {
		night: false,
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
		gifts: ["#b8432f", "#c46a2c", "#c99a4a", "#a8532a", "#b8702f"],
		foliage: ["#b4543a", "#c4793f", "#a88a4c", "#8e5634", "#b06a3c"],
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
		night: true,
		paper: "#111a1a",
		dots: "#cfe3d816",
		face: "#3e4a44",
		plinth: "#2c4433",
		pad: "#3a3a2e",
		ink: "#120d09",
		belt: "#5a4733",
		kraft: "#8f6a42",
		tape: "#e6d3ad",
		selected: "#ff8a1f",
		tint: {
			processor: "#7a6044",
			tank: "#87603f",
			loader: "#786446",
			gateway: "#666a60",
			shed: "#76543b",
		},
		gifts: ["#a8402e", "#b25e1f", "#a88440", "#8f4d2b", "#a5652a"],
		foliage: ["#8e3f2e", "#a05e2e", "#84723d", "#6c432c", "#94582c"],
		trunk: "#4f3726",
		evergreen: "#2f4a3a",
		cloud: "#34403c",
		stone: "#626a63",
		iron: "#1c201e",
		soil: "#3d2f25",
		birch: "#c6c9bf",
		water: "#21424a",
		glow: "#ffb347",
		sign: "#3a2a1e",
		signInk: "#f2e2c2",
	},
} satisfies Record<"light" | "dark", InkPalette>

export function mapPalette(dark: boolean): InkPalette {
	return MAPLE[dark ? "dark" : "light"]
}

/** Face tones for a camera on the (+x, +y, +z) diagonal: roofs stay lit, the
 * two visible walls step down. Matches hand-drawn isometric shading. */
export const FACE_TONE = { top: 1, front: 0.93, side: 0.85, hidden: 0.8 } as const

/** Paper with a faint dot grid, theme-aware like the rest of the chrome. */
export function paperBackground(palette: InkPalette) {
	return {
		backgroundColor: palette.paper,
		backgroundImage: `radial-gradient(${palette.dots} 1px, transparent 1.2px)`,
		backgroundSize: "18px 18px",
	} as const
}
