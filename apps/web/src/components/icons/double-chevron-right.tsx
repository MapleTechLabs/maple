import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = ["M5 6L11 12L5 18", "M13 6L19 12L13 18"]

function DoubleChevronRightIcon({ size = 24, className, ...props }: IconProps) {
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

export { DoubleChevronRightIcon }
