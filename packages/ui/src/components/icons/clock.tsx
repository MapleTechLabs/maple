import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M20 6L20 6.01",
	"M18 4L18 4.01",
	"M22 8L22 16",
	"M16 2L12 2",
	"M12 22H16",
	"M18 20L18 20.01",
	"M20 18L20 18.01",
	"M12 12V8",
	"M16 16L16 16.01",
	"M14 14L14 14.01",
	"M2 12L2 12.01",
	"M5 5L5 5.01",
	"M5 19L5 19.01",
]

function ClockIcon({ size = 24, className, ...props }: IconProps) {
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
export { ClockIcon }
