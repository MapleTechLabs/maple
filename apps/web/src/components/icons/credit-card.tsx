import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = ["M7 15H8", "M22 9H2", "M2 18V6", "M22 18V6", "M4 4H20", "M4 20H20"]

function CreditCardIcon({ size = 24, className, ...props }: IconProps) {
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
export { CreditCardIcon }
