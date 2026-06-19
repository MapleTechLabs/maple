import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = ["M7 4V20", "M3 8L7 4L11 8", "M17 20V4", "M13 16L17 20L21 16"]

function ArrowUpDownIcon({ size = 24, className, ...props }: IconProps) {
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
export { ArrowUpDownIcon }
