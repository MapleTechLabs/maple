import type { IconProps } from "./icon"

function MediaPauseIcon({ size = 24, className, ...props }: IconProps) {
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
			<path d="M5 4H9V20H5V4Z" />
			<path d="M15 4H19V20H15V4Z" />
		</svg>
	)
}
export { MediaPauseIcon }
