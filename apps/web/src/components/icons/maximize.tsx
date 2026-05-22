import type { IconProps } from "./icon"

function MaximizeIcon({ size = 24, className, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			className={className}
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			{...props}
		>
			<path d="M9 4H4V9" />
			<path d="M20 9V4H15" />
			<path d="M15 20H20V15" />
			<path d="M4 15V20H9" />
		</svg>
	)
}
export { MaximizeIcon }
