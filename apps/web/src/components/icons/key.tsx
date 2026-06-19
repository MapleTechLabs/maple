import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = ["M4 5H9V10H4Z", "M9 10L18 19", "M18 19L20 17", "M14 15L16 13"]

function KeyIcon({ size = 24, className, ...props }: IconProps) {
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
export { KeyIcon }
