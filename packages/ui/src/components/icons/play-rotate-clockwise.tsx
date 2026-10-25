import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M4 6L4 6.01",
	"M6 4L6 4.01",
	"M20.01 6L20 6",
	"M18.01 4L18 4",
	"M20.01 18L20 18",
	"M18.01 20L18 20",
	"M6.01001 20L6.00001 20",
	"M4.01001 18L4.00001 18",
	"M2 8L2 16",
	"M22 14L22 16",
	"M8 2L16 2",
	"M8 22L16 22",
	"M22 8V4",
	"M17 12.01V12",
	"M14 10H15",
	"M14 14H15",
	"M12 8H9L9 16L12 16",
]

function PlayRotateClockwiseIcon({ size = 24, className, ...props }: IconProps) {
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
export { PlayRotateClockwiseIcon }
