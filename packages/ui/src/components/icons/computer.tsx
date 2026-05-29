import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M9 6H15",
	"M7 2H17",
	"M7 22H17",
	"M19 20V4",
	"M5 20V4",
	"M12 14H12.01",
	"M12 18H12.01",
	"M10 16H10.01",
	"M14 16H14.01",
]

function ComputerIcon({ size = 24, className, ...props }: IconProps) {
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
				<path key={i} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			))}
		</svg>
	)
}
export { ComputerIcon }
