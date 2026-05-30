import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M19 21L9 21",
	"M5 15H5.0001",
	"M21 11L21 19",
	"M7 11L7 19",
	"M19 9L9 9",
	"M17 5L17 7",
	"M3 5L3 13",
	"M15 3L5 3",
]

function CopyIcon({ size = 24, className, ...props }: IconProps) {
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
export { CopyIcon }
