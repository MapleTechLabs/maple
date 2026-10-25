import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M2 15.01V15",
	"M4 13.01V13",
	"M6 11.01V11",
	"M8 9.01V9",
	"M10 11.01V11",
	"M12 13.01V13",
	"M14 15.01V15",
	"M16 13.01V13",
	"M18 11.01V11",
	"M20 9.01V9",
	"M22 7.01V7",
]

function ChartLineIcon({ size = 24, className, ...props }: IconProps) {
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
export { ChartLineIcon }
