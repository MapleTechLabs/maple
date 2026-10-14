import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M18 15L14 15",
	"M18 11L14 11",
	"M9 4V6H15V4",
	"M11 2H13",
	"M20 5H19",
	"M5 5H4",
	"M2 7V18",
	"M22 7V18",
	"M4 20H20",
	"M8 11H6V15H10V13",
]

function IdBadgeIcon({ size = 24, className, ...props }: IconProps) {
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
export { IdBadgeIcon }
