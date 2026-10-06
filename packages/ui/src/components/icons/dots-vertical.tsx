import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = ["M12 5L12 5.01", "M12 12L12 12.01", "M12 19L12 19.01"]

function DotsVerticalIcon({ size = 24, className, ...props }: IconProps) {
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
				<path key={i} d={d} stroke="currentColor" strokeWidth="3" strokeLinecap="square" />
			))}
		</svg>
	)
}
export { DotsVerticalIcon }
