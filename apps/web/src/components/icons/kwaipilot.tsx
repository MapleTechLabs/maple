import type { IconProps } from "./icon"

/** Kwaipilot (Kuaishou). */
function KwaipilotIcon({ size = 24, className, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			className={className}
			fill="currentColor"
			fillRule="evenodd"
			aria-hidden="true"
			{...props}
		>
			<path
				clipRule="evenodd"
				d="M11.765.03C5.327.03.108 5.25.108 11.686c0 3.514 1.556 6.665 4.015 8.804L9.89 8.665h6.451L9.31 23.083c.807.173 1.63.26 2.455.26 6.438 0 11.657-5.22 11.657-11.658S18.202.028 11.765.028V.03z"
			/>
		</svg>
	)
}
export { KwaipilotIcon }
