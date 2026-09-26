import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M17 6.5V6.49",
	"M13 6.5V6.49",
	"M17 17.5V17.49",
	"M13 17.5V17.49",
	"M5 3L19 3",
	"M5 10L19 10",
	"M5 14L19 14",
	"M5 21L19 21",
	"M3 16V19",
	"M21 16V19",
	"M21 5V8",
	"M3 5V8",
]

function ServerIcon({ size = 24, className, ...props }: IconProps) {
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
export { ServerIcon }
