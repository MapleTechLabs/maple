import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M12 22L7 20L5 15L7 10L9 12L9 7L12 2L14 7L16 6L18 11L19 16L16 21L12 22Z",
	"M12 19L10 16L12 12L14 16L12 19Z",
]

function FireIcon({ size = 24, className, ...props }: IconProps) {
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
export { FireIcon }
