import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M7 4Q3 12 7 20",
	"M17 4Q21 12 17 20",
	"M9 12H9.01",
	"M12 12H12.01",
	"M15 12H15.01",
]

/** A function call, `(···)`. */
function ParenthesesDotsIcon({ size = 24, className, ...props }: IconProps) {
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
			{paths.map((d) => (
				<path key={d} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			))}
		</svg>
	)
}

export { ParenthesesDotsIcon }
