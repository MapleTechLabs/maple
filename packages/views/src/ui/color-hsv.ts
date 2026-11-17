import { Array as Arr, Option, String as Str } from "effect"

/** HSV and `#rrggbb` for the colour picker: hue in degrees 0 to 360, saturation and value 0 to 1. */
export type Hsv = Readonly<{ hue: number; saturation: number; value: number }>

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/** `#abc`, `abc` or `#AABBCC` as lower-case `#aabbcc`; anything else is none. */
export const normalizeHex = (text: string): Option.Option<string> => {
	const match = HEX.exec(Str.trim(text))
	if (match === null) return Option.none()
	const digits = match[1] ?? ""
	const full =
		digits.length === 3
			? Arr.join(
					Arr.map(Str.split(digits, ""), (digit) => digit + digit),
					"",
				)
			: digits
	return Option.some(`#${Str.toLowerCase(full)}`)
}

const channel = (unit: number): string =>
	Str.padStart(2, "0")(Math.round(clamp(unit, 0, 1) * 255).toString(16))

export const hsvToHex = ({ hue, saturation, value }: Hsv): string => {
	const s = clamp(saturation, 0, 1)
	const v = clamp(value, 0, 1)
	const sector = (((hue % 360) + 360) % 360) / 60
	const chroma = v * s
	const x = chroma * (1 - Math.abs((sector % 2) - 1))
	const m = v - chroma
	const [r, g, b] =
		sector < 1
			? [chroma, x, 0]
			: sector < 2
				? [x, chroma, 0]
				: sector < 3
					? [0, chroma, x]
					: sector < 4
						? [0, x, chroma]
						: sector < 5
							? [x, 0, chroma]
							: [chroma, 0, x]
	return `#${channel(r + m)}${channel(g + m)}${channel(b + m)}`
}

/**
 * The HSV of a hex colour. A grey has no hue and black no saturation either, so those come from
 * `previous`: the hue slider stays where it was while the picked colour passes through grey.
 */
export const hexToHsv = (text: string, previous?: Hsv): Option.Option<Hsv> =>
	Option.map(normalizeHex(text), (hex) => {
		const at = (start: number) => Number.parseInt(Str.slice(start, start + 2)(hex), 16) / 255
		const r = at(1)
		const g = at(3)
		const b = at(5)
		const max = Math.max(r, g, b)
		const delta = max - Math.min(r, g, b)
		const hue =
			delta === 0
				? (previous?.hue ?? 0)
				: max === r
					? (60 * ((g - b) / delta) + 360) % 360
					: max === g
						? 60 * ((b - r) / delta + 2)
						: 60 * ((r - g) / delta + 4)
		const saturation = max === 0 ? (previous?.saturation ?? 0) : delta / max
		return { hue, saturation, value: max }
	})
