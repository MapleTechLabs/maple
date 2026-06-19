import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = ["M3 21L3 3", "M7 12L21 12", "M15 6L21 12L15 18"]

function ArrowRightFromLineIcon({ size = 24, className, ...props }: IconProps) {
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
export { ArrowRightFromLineIcon }
