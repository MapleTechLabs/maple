import type { IconProps } from "./icon"

/**
 * Cloud Run's mark in one colour: a chevron and a triangle, their upper halves at reduced
 * opacity where the brand mark is lighter.
 */
function CloudRunIcon({ size = 24, className, ...props }: IconProps) {
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
			<path d="M2 3.5H8.5L13.5 12H7Z" opacity=".55" />
			<path d="M7 12H13.5L8.5 20.5H2Z" />
			<path d="M14 6.5L22 12H14Z" opacity=".55" />
			<path d="M14 12H22L14 17.5Z" />
		</svg>
	)
}

export { CloudRunIcon }
