import type { IconProps } from "./icon"

// Nucleo Pixel "mobile-toolbar": vertical smartphone — body edges, earpiece, home bar.
const paths: ReadonlyArray<string> = ["M9 18H15", "M11 6L13 6", "M7 2H17", "M7 22H17", "M5 20V4", "M19 20V4"]

function MobileIcon({ size = 24, className, ...props }: IconProps) {
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
export { MobileIcon }
