import { cn } from "@maple/ui/lib/utils"

import type { MapleRegion } from "@/lib/region"

// Both flags are drawn on the same 3:2 box so they sit side by side at one size.
const W = 60
const H = 40

/** Flag colours, also used to tint whatever the flag stands for. */
export const REGION_FLAG_COLORS = {
	us: { primary: "#B22234", secondary: "#3C3B6E" },
	eu: { primary: "#003399", secondary: "#FFCC00" },
} as const satisfies Record<MapleRegion, { primary: string; secondary: string }>

const US_STRIPE = H / 13
const US_CANTON_W = W * 0.4
const US_CANTON_H = US_STRIPE * 7
const US_STARS = Array.from({ length: 9 }, (_, row) =>
	Array.from({ length: row % 2 === 0 ? 6 : 5 }, (_, col) => ({
		cx: (row % 2 === 0 ? 2 : 4) * (US_CANTON_W / 24) + col * 4 * (US_CANTON_W / 24),
		cy: (row + 1) * (US_CANTON_H / 10),
	})),
).flat()

// Twelve five-pointed stars on a circle a third of the flag's height, as the flag is specified.
const EU_STAR_POINTS = (() => {
	const outer = H / 18
	const inner = outer * 0.382
	return Array.from({ length: 10 }, (_, i) => {
		const angle = -Math.PI / 2 + (i * Math.PI) / 5
		const radius = i % 2 === 0 ? outer : inner
		return `${(radius * Math.cos(angle)).toFixed(3)},${(radius * Math.sin(angle)).toFixed(3)}`
	}).join(" ")
})()
const EU_STARS = Array.from({ length: 12 }, (_, i) => {
	const angle = (i * Math.PI) / 6
	return { x: W / 2 + (H / 3) * Math.sin(angle), y: H / 2 - (H / 3) * Math.cos(angle) }
})

function UsFlag() {
	const { primary, secondary } = REGION_FLAG_COLORS.us
	return (
		<>
			<rect width={W} height={H} fill="#FFFFFF" />
			{Array.from({ length: 7 }, (_, i) => (
				<rect key={i} y={i * 2 * US_STRIPE} width={W} height={US_STRIPE} fill={primary} />
			))}
			<rect width={US_CANTON_W} height={US_CANTON_H} fill={secondary} />
			{US_STARS.map((star) => (
				<circle key={`${star.cx}-${star.cy}`} cx={star.cx} cy={star.cy} r={0.55} fill="#FFFFFF" />
			))}
		</>
	)
}

function EuFlag() {
	const { primary, secondary } = REGION_FLAG_COLORS.eu
	return (
		<>
			<rect width={W} height={H} fill={primary} />
			{EU_STARS.map((star) => (
				<polygon
					key={`${star.x}-${star.y}`}
					points={EU_STAR_POINTS}
					transform={`translate(${star.x} ${star.y})`}
					fill={secondary}
				/>
			))}
		</>
	)
}

/** The region's flag, rounded and outlined so it sits on dark surfaces. */
export function RegionFlag({ region, className }: { region: MapleRegion; className?: string }) {
	const clipId = `region-flag-${region}`
	return (
		<svg
			viewBox={`0 0 ${W} ${H}`}
			role="img"
			aria-label={region === "eu" ? "Flag of the European Union" : "Flag of the United States"}
			className={cn("h-8 w-12 shrink-0", className)}
		>
			<defs>
				<clipPath id={clipId}>
					<rect width={W} height={H} rx={4} />
				</clipPath>
			</defs>
			<g clipPath={`url(#${clipId})`}>{region === "eu" ? <EuFlag /> : <UsFlag />}</g>
			<rect
				x={0.5}
				y={0.5}
				width={W - 1}
				height={H - 1}
				rx={3.5}
				fill="none"
				stroke="#FFFFFF"
				strokeOpacity={0.14}
			/>
		</svg>
	)
}
