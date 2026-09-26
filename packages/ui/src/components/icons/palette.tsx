import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M12 3L6 5L3 10L4 15L8 18L11 17L12 20L17 19L21 13L20 6L12 3Z",
	"M8 9L8 9.01",
	"M13 7L13 7.01",
	"M17 11L17 11.01",
	"M14 15L14 15.01",
]

function PaletteIcon({ size = 24, className, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			className={className}
			fill="none"
			aria-hidden="true"
			{...props}
		>
			{paths.map((d, i) => (
				<path key={i} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			))}
		</svg>
	)
}
export { PaletteIcon }
