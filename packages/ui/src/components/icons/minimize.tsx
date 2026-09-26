import type { IconProps } from "./icon"

function MinimizeIcon({ size = 24, className, ...props }: IconProps) {
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
			<path d="M4 9H9V4" />
			<path d="M15 4V9H20" />
			<path d="M20 15H15V20" />
			<path d="M9 20V15H4" />
		</svg>
	)
}
export { MinimizeIcon }
