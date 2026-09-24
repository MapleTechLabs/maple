import type { IconProps } from "./icon"

/**
 * Nucleo Arcade `key`. Arcade is a pixel-art set: the glyph is a list of lit pixels on a 30×30 grid,
 * each drawn as a zero-length stroke 4 units wide with a square cap. That is why the viewBox is 30
 * rather than the 24 the outline icons use, and why `strokeLinecap="square"` is load-bearing — round
 * caps turn every pixel into a dot. Rows below run top to bottom, left to right across the grid.
 */
const paths: ReadonlyArray<string> = [
	"M7 7H7.01",
	"M11 7H11.01",
	"M3 11H3.01",
	"M15 11H15.01",
	"M3 15H3.01",
	"M7 15H7.01",
	"M15 15H15.01",
	"M19 15H19.01",
	"M23 15H23.01",
	"M27 15H27.01",
	"M3 19H3.01",
	"M7 19H7.01",
	"M11 19H11.01",
	"M15 19H15.01",
	"M23 19H23.01",
	"M27 19H27.01",
	"M7 23H7.01",
	"M11 23H11.01",
]

function KeyIcon({ size = 24, className, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 30 30"
			width={size}
			height={size}
			className={className}
			fill="none"
			aria-hidden="true"
			{...props}
		>
			{paths.map((d, i) => (
				<path key={i} d={d} stroke="currentColor" strokeWidth="4" strokeLinecap="square" />
			))}
		</svg>
	)
}
export { KeyIcon }
