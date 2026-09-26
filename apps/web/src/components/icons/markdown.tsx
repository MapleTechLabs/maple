import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M3 5H21",
	"M3 19H21",
	"M23 7V17",
	"M1 7V17",
	"M5 15V9H6",
	"M11 15V9H10",
	"M17 9L17 15",
	"M17 12.99L17 13",
	"M19 13H15",
	"M18 14H16",
]

function MarkdownIcon({ size = 24, className, ...props }: IconProps) {
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
			<rect x="7" y="10" width="2" height="2" fill="currentColor" />
		</svg>
	)
}
export { MarkdownIcon }
