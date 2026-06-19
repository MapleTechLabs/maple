import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = ["M12 3L21 8L12 13L3 8L12 3Z", "M3 13L12 18L21 13"]

function LayersIcon({ size = 24, className, ...props }: IconProps) {
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
					strokeLinecap="square"
					strokeLinejoin="round"
				/>
			))}
		</svg>
	)
}
export { LayersIcon }
