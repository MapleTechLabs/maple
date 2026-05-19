import type { IconProps } from "./icon"

function GitCommitIcon({ size = 24, className, ...props }: IconProps) {
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
			<circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="2" />
			<path d="M3 12H8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
			<path d="M16 12H21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		</svg>
	)
}
export { GitCommitIcon }
