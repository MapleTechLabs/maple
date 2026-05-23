import type { IconProps } from "./icon"

function MediaPlayIcon({ size = 24, className, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			className={className}
			fill="currentColor"
			aria-hidden="true"
			{...props}
		>
			<path d="M6 4L6 20L20 12L6 4Z" />
		</svg>
	)
}
export { MediaPlayIcon }
