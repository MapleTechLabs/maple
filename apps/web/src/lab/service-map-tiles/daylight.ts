import { Array as Arr, Schema, String as Str } from "effect"

// The light on the map, from the hour on the viewer's clock: where the sun (or the moon) stands,
// what colour it is and how strong, the colour of the sky's fill light, and how far the windows
// are lit. Day length follows the season, as it would at a middling latitude.

/** The viewer's clock: the hour of the day with its fraction, and the day of the year. */
export const Clock = Schema.Struct({
	hour: Schema.Number,
	day: Schema.Number,
	/** South of the equator, where the long days come at the other end of the year. */
	isSouthern: Schema.Boolean,
})
export type Clock = typeof Clock.Type

/** How the map is lit: by the clock, or held at one time of day. */
export const LightMode = Schema.Literals(["clock", "dawn", "day", "dusk", "night"])
export type LightMode = typeof LightMode.Type

export const LIGHT_MODES: ReadonlyArray<LightMode> = ["clock", "dawn", "day", "dusk", "night"]

export type TimeOfDay = "dawn" | "day" | "dusk" | "night"

/** Red, green and blue, 0 to 1 in sRGB. */
export type Tone = readonly [number, number, number]

export interface Daylight {
	readonly timeOfDay: TimeOfDay
	/** Degrees above the horizon; below zero the sun is down and the moon lights the map. */
	readonly elevation: number
	/** Which way the light comes from: a unit vector pointing at the sun or the moon. */
	readonly direction: readonly [number, number, number]
	readonly sun: Tone
	readonly sunPower: number
	readonly sky: Tone
	readonly bounce: Tone
	readonly skyPower: number
	/** How far the windows are lit, 0 by day to 1 at night. */
	readonly lamps: number
	/** How much of the sun's or the moon's light is left, 1 but for the hand-over between them. */
	readonly direct: number
}

/** How much of the direct light is left at the hand-over from sun to moon. */
const DIP = 0.12

/** When the sun is highest, by the clock: a little after twelve, for summer time's sake. */
const NOON = 12.5

/** Sunrise and sunset as hours on the clock for `day` of the year. */
export const sunTimes = ({ day, isSouthern }: Pick<Clock, "day" | "isSouthern">) => {
	// Longest about the 21st of June in the north, and of December in the south.
	const season = Math.cos((2 * Math.PI * (day - 172)) / 365) * (isSouthern ? -1 : 1)
	const length = 12 + 3.5 * season
	return { rise: NOON - length / 2, set: NOON + length / 2, length }
}

/** The hour a held time of day stands for; the clock's own hour for `clock`. */
export const hourFor = (mode: LightMode, clock: Clock): number => {
	const { rise, set } = sunTimes(clock)
	const held = { clock: clock.hour, dawn: rise + 0.3, day: NOON, dusk: set - 0.3, night: 0.5 }
	return held[mode]
}

const smooth = (from: number, to: number, value: number): number => {
	const t = Math.min(1, Math.max(0, (value - from) / (to - from)))
	return t * t * (3 - 2 * t)
}

const mix = (a: number, b: number, t: number): number => a + (b - a) * t

interface Look {
	readonly sun: Tone
	readonly sunPower: number
	readonly sky: Tone
	readonly bounce: Tone
	readonly skyPower: number
}

const blend = (a: Look, b: Look, t: number): Look => {
	const tone = (x: Tone, y: Tone): Tone => [mix(x[0], y[0], t), mix(x[1], y[1], t), mix(x[2], y[2], t)]
	return {
		sun: tone(a.sun, b.sun),
		sunPower: mix(a.sunPower, b.sunPower, t),
		sky: tone(a.sky, b.sky),
		bounce: tone(a.bounce, b.bounce),
		skyPower: mix(a.skyPower, b.skyPower, t),
	}
}

// Moonlight is cool and weak with a deep blue fill; the low sun is warm with a rosy sky in the
// morning and an orange one in the evening; the high sun is the plain white light of midday.
const NIGHT: Look = {
	sun: [0.66, 0.76, 0.98],
	sunPower: 1,
	sky: [0.46, 0.55, 0.82],
	bounce: [0.18, 0.22, 0.38],
	skyPower: 1.25,
}
const DAWN: Look = {
	sun: [1, 0.8, 0.66],
	sunPower: 1.8,
	sky: [0.97, 0.88, 0.93],
	bounce: [0.6, 0.64, 0.74],
	skyPower: 1.6,
}
const DUSK: Look = {
	sun: [1, 0.72, 0.48],
	sunPower: 1.9,
	sky: [0.99, 0.87, 0.8],
	bounce: [0.6, 0.58, 0.7],
	skyPower: 1.6,
}
const DAY: Look = {
	sun: [1, 0.96, 0.88],
	sunPower: 2.6,
	sky: [1, 1, 1],
	bounce: [0.79, 0.84, 0.69],
	skyPower: 2,
}

/** How high the sun stands at `hour`, in degrees: up to about 65 on a summer noon, 30 on a
 * winter one, and as far below the horizon at midnight. */
export const elevationAt = (clock: Clock): number => {
	const { rise, set, length } = sunTimes(clock)
	const hour = ((clock.hour % 24) + 24) % 24
	if (hour >= rise && hour <= set) {
		const highest = 30 + 35 * ((length - 8.5) / 7)
		return highest * Math.sin((Math.PI * (hour - rise)) / length)
	}
	const since = hour > set ? hour - set : hour + 24 - set
	return -45 * Math.sin((Math.PI * since) / (24 - length))
}

/** The light at `clock`. It changes smoothly through the day: the colours of two neighbouring
 * times of day are mixed by how high the sun stands. */
export const daylightAt = (clock: Clock): Daylight => {
	const { rise, length } = sunTimes(clock)
	const hour = ((clock.hour % 24) + 24) % 24
	const elevation = elevationAt(clock)
	const isMorning = hour < NOON
	const up = smooth(-7, 3, elevation)
	const high = smooth(3, 20, elevation)
	const look = blend(blend(NIGHT, isMorning ? DAWN : DUSK, up), DAY, high)
	// The sun crosses from one side of the board to the other; the moon stands still behind it.
	const across = Math.min(1, Math.max(0, (hour - rise) / length))
	// The light is all but out as the sun hands over to the moon, three degrees under the
	// horizon. It turns from the sun's side to the moon's only then, a little at a time, so no
	// shadow is seen to swing from one side of a house to the other.
	const direct = DIP + (1 - DIP) * Math.min(1, Math.abs(elevation + 3) / 9)
	const moon = 1 - smooth(-4.5, -1.5, elevation)
	// The sun is kept off the horizon, or the shadows would run off the edge of the board.
	const height = (mix(Math.max(elevation, 11), 48, moon) * Math.PI) / 180
	const [x, z] = [mix(-Math.cos(Math.PI * across), 0.55, moon), mix(0.42, -0.6, moon)]
	const flat = Math.max(1e-6, Math.hypot(x, z))
	return {
		timeOfDay: elevation < -3 ? "night" : elevation > 14 ? "day" : isMorning ? "dawn" : "dusk",
		elevation,
		direction: [(x / flat) * Math.cos(height), Math.sin(height), (z / flat) * Math.cos(height)],
		sun: look.sun,
		sunPower: look.sunPower * direct,
		sky: look.sky,
		bounce: look.bounce,
		skyPower: look.skyPower,
		lamps: 1 - smooth(-3, 6, elevation),
		direct,
	}
}

/** The clock for a moment in the viewer's own time zone. */
export const clockOf = (date: Date, timeZone: string): Clock => {
	const start = new Date(date.getFullYear(), 0, 0)
	return {
		hour: date.getHours() + date.getMinutes() / 60,
		day: Math.floor((date.getTime() - start.getTime()) / 86_400_000),
		isSouthern: isSouthernZone(timeZone),
	}
}

/** Whether a time zone lies south of the equator, by its name. */
export const isSouthernZone = (timeZone: string): boolean =>
	SOUTHERN_REGIONS.test(timeZone) || SOUTHERN_ZONES.has(timeZone)

/** Regions that lie wholly south of the equator, and the old names for some of them. */
const SOUTHERN_REGIONS = /^(Australia|Antarctica|America\/Argentina|Brazil|Chile)\//

// Every other zone the time zone database places south of the equator, with the older names
// browsers still report for a few of them. Cities are listed by region, a space between each.
const SOUTHERN_CITIES: ReadonlyArray<readonly [region: string, cities: string]> = [
	["Africa", "Blantyre Brazzaville Bujumbura Dar_es_Salaam Gaborone Harare Johannesburg Kigali"],
	["Africa", "Kinshasa Luanda Lubumbashi Lusaka Maputo Maseru Mbabane Nairobi Windhoek"],
	["America", "Araguaina Asuncion Bahia Belem Buenos_Aires Campo_Grande Catamarca Cordoba Coyhaique"],
	["America", "Cuiaba Eirunepe Fortaleza Guayaquil Jujuy La_Paz Lima Maceio Manaus Mendoza"],
	["America", "Montevideo Noronha Porto_Acre Porto_Velho Punta_Arenas Recife Rio_Branco Rosario"],
	["America", "Santarem Santiago Sao_Paulo"],
	["Asia", "Dili Jakarta Jayapura Makassar Pontianak Ujung_Pandang"],
	["Atlantic", "South_Georgia St_Helena Stanley"],
	["Indian", "Antananarivo Chagos Christmas Cocos Comoro Kerguelen Mahe Mauritius Mayotte Reunion"],
	["Pacific", "Apia Auckland Bougainville Chatham Easter Efate Enderbury Fakaofo Fiji Funafuti"],
	["Pacific", "Galapagos Gambier Guadalcanal Kanton Marquesas Nauru Niue Norfolk Noumea Pago_Pago"],
	["Pacific", "Pitcairn Port_Moresby Rarotonga Samoa Tahiti Tongatapu Wallis"],
]

const SOUTHERN_ZONES: ReadonlySet<string> = new Set(
	Arr.flatMap(SOUTHERN_CITIES, ([region, cities]) =>
		Arr.map(Str.split(cities, " "), (city) => `${region}/${city}`),
	),
)
