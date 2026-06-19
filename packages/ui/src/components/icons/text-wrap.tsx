import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = ["M3 6h18", "M3 12h13a3 3 0 1 1 0 6h-4", "M3 18h6", "M11 16l-2 2 2 2"]

function TextWrapIcon({ size = 24, className, ...props }: IconProps) {
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
				<path
					key={i}
					d={d}
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			))}
		</svg>
	)
}
export { TextWrapIcon }
