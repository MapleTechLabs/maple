import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M7 21H5",
	"M15 18L21 18",
	"M9 19L9 17",
	"M3 19L3 17",
	"M7 15H5",
	"M7 9H5",
	"M15 6L21 6",
	"M9 7L9 5",
	"M3 7L3 5",
	"M7 3L5 3",
]

function UnorderedListIcon({ size = 24, className, ...props }: IconProps) {
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
export { UnorderedListIcon }
