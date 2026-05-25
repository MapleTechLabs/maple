import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M16 7H12",
	"M12 19V7",
	"M8 19H16",
	"M2 17V7",
	"M22 17V15",
	"M6 17H6.01",
	"M18 17H18.01",
	"M20 13H20.01",
	"M6 21H6.01",
	"M18 21H18.01",
	"M4 19H4.01",
	"M16 19H16.01",
	"M8 19H8.01",
	"M20 19H20.01",
	"M10 5H4",
	"M18 11V9",
]

function TruckIcon({ size = 24, className, ...props }: IconProps) {
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
export { TruckIcon }
