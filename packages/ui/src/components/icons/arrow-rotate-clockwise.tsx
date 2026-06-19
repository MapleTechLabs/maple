import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M21.5 12C21.5 17.2467 17.2467 21.5 12 21.5C6.75329 21.5 2.5 17.2467 2.5 12C2.5 6.75329 6.7533 2.5 12 2.5C15.6186 2.5 18.7646 4.52314 20.3687 7.5",
	"M20.5 2.5V7.5H15.5",
]

function ArrowRotateClockwiseIcon({ size = 24, className, ...props }: IconProps) {
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
export { ArrowRotateClockwiseIcon }
