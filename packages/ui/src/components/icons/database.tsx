import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M8 3H16",
	"M5 4L5 4.01",
	"M19 4L19 4.01",
	"M3 6V18",
	"M21 6V18",
	"M3 12H21",
	"M8 21H16",
	"M5 20L5 20.01",
	"M19 20L19 20.01",
]

function DatabaseIcon({ size = 24, className, ...props }: IconProps) {
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
export { DatabaseIcon }
