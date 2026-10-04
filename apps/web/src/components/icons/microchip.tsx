import type { IconProps } from "./icon"

const pins: ReadonlyArray<string> = [
	"M7 4V2",
	"M7 22V20",
	"M17 4V2",
	"M17 22V20",
	"M12 4V2",
	"M12 22V20",
	"M20 7L22 7",
	"M2 7L4 7",
	"M20 17L22 17",
	"M2 17L4 17",
	"M20 12L22 12",
	"M2 12L4 12",
]

function MicrochipIcon({ size = 24, className, ...props }: IconProps) {
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
			{pins.map((d) => (
				<path key={d} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			))}
			<path
				d="M18 4H6C4.89543 4 4 4.89543 4 6V18C4 19.1046 4.89543 20 6 20H18C19.1046 20 20 19.1046 20 18V6C20 4.89543 19.1046 4 18 4Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
			<path
				d="M14 16C15.1046 16 16 15.1046 16 14C16 12.8954 15.1046 12 14 12C12.8954 12 12 12.8954 12 14C12 15.1046 12.8954 16 14 16Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
		</svg>
	)
}

export { MicrochipIcon }
