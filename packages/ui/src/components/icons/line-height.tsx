import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = ["M3 5h18", "M3 19h18", "M9 9l3-3 3 3", "M9 15l3 3 3-3", "M12 6v12"]

function LineHeightIcon({ size = 24, className, ...props }: IconProps) {
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
export { LineHeightIcon }
