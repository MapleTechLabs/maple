import type { IconProps } from "./icon"

function GitBranchIcon({ size = 24, className, ...props }: IconProps) {
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
			<circle cx="6" cy="6" r="2.5" stroke="currentColor" strokeWidth="2" />
			<circle cx="6" cy="18" r="2.5" stroke="currentColor" strokeWidth="2" />
			<circle cx="18" cy="6" r="2.5" stroke="currentColor" strokeWidth="2" />
			<path d="M6 9V15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
			<path d="M18 9V12C18 13.6569 16.6569 15 15 15H10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		</svg>
	)
}
export { GitBranchIcon }
