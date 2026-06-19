import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = ["M7 4h10", "M9 4l-1 7-2 2v2h12v-2l-2-2-1-7", "M12 15v5"]

function ThumbtackIcon({ size = 24, className, ...props }: IconProps) {
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
				<path
					key={i}
					d={d}
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			))}
		</svg>
	)
}
export { ThumbtackIcon }
