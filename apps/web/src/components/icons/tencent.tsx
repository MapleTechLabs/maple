import type { IconProps } from "./icon"

/** Tencent. */
function TencentIcon({ size = 24, className, ...props }: IconProps) {
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
			<path d="M9.976 1L24 9.8l-10.587.015L10.723 23H5.489L8.18 9.8H3.244L1 5.4h8.077L9.976 1z" />
		</svg>
	)
}
export { TencentIcon }
