import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M20 6L20 6.01",
	"M18 4L18 4.01",
	"M3.98999 6L3.99999 6",
	"M5.98999 4L5.99999 4",
	"M3.98999 18L3.99999 18",
	"M5.98999 20L5.99999 20",
	"M17.99 20L18 20",
	"M19.99 18L20 18",
	"M22 8L22 16",
	"M16 2L8 2",
	"M16 22L8 22",
	"M2 8V4",
]

function ArrowRotateAnticlockwiseIcon({ size = 24, className, ...props }: IconProps) {
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
export { ArrowRotateAnticlockwiseIcon }
