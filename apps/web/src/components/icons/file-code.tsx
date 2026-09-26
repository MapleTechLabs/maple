import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M12 4V10H8",
	"M4 20L4 10",
	"M20 12L20 4",
	"M12 2L18 2",
	"M6 22H8",
	"M6 8H6.01",
	"M8 6H8.01",
	"M10 4H10.01",
	"M22 19H22.01",
	"M12.01 19H12",
	"M20.5 17.5H20.51",
	"M13.51 17.5H13.5",
	"M19 16H19.01",
	"M15.01 16H15",
	"M20.5 20.5H20.51",
	"M13.51 20.5H13.5",
	"M19 22H19.01",
	"M15.01 22H15",
]

function FileCodeIcon({ size = 24, className, ...props }: IconProps) {
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
export { FileCodeIcon }
