import type { ReactNode } from "react"

// Nucleo geometry from Maple’s existing icon set (apps/web/src/components/icons).
const icons = {
	"branch-fork": (
		<>
			{" "}
			<path
				d="M7 21V13c0-2.2 1.8-4 4-4h6"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
			<path d="M7 11V3" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<circle cx="7" cy="21" r="2" stroke="currentColor" strokeWidth="2" />
			<circle cx="19" cy="9" r="2" stroke="currentColor" strokeWidth="2" />
			<circle cx="7" cy="3" r="2" stroke="currentColor" strokeWidth="2" />{" "}
		</>
	),
	"chart-bar": (
		<>
			{" "}
			{[
				"M2 20H22",
				"M4 8L4 8.01",
				"M20 11L20 11.01",
				"M12 3L12 3.01",
				"M2 10V16H6V10",
				"M18 13V16H22V13",
				"M10 5V16H14V5",
			].map((d, index) => (
				<path key={index} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			))}{" "}
		</>
	),
	"circle-question": (
		<>
			{" "}
			{[
				"M8 2L16 2",
				"M8 22L16 22",
				"M2 8L2 16",
				"M22 8L22 16",
				"M6 4L6 4.01",
				"M4 6L4 6.01",
				"M18 4L18 4.01",
				"M20 6L20 6.01",
				"M6 20L6 20.01",
				"M4 18L4 18.01",
				"M18 20L18 20.01",
				"M20 18L20 18.01",
				"M9 9V8H15V11L12 13V15",
				"M12 18L12 18.01",
			].map((d, index) => (
				<path key={index} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			))}{" "}
		</>
	),
	compass: (
		<>
			{" "}
			{[
				"M8 2L16 2",
				"M6 4L6 4.01",
				"M18.01 4L18 4",
				"M4 6L4 6.01",
				"M10 10L10 10.01",
				"M14 14L14 14.01",
				"M20.01 6L20 6",
				"M2 8L2 16",
				"M22 8L22 16",
				"M4.01001 18L4.00001 18",
				"M20.01 18L20 18",
				"M6.01001 20L6.00001 20",
				"M18.01 20L18 20",
				"M8 22L16 22",
				"M8 12V16H12",
				"M16 12L16 8L12 8",
			].map((d, index) => (
				<path key={index} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			))}{" "}
		</>
	),
	cube: (
		<>
			{" "}
			{[
				"M12 3V9",
				"M3 9H21",
				"M17 17L15 17",
				"M5 21H19",
				"M6 3H18",
				"M3 19V9",
				"M21 19V9",
				"M20 7L20 7.01",
				"M4.00001 7L4 7.01",
				"M5.00001 5L5 5.01",
				"M19 5L19 5.01",
			].map((d, index) => (
				<path key={index} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			))}{" "}
		</>
	),
	download: (
		<>
			{" "}
			{["M12 3V14", "M7 10L12 15L17 10", "M4 18V21H20V18"].map((d, index) => (
				<path key={index} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			))}{" "}
		</>
	),
	"face-robot": (
		<>
			{" "}
			{[
				"M10 16V20",
				"M14 16V20",
				"M5.90909 20L5.90909 16H18.0909L18.0909 20",
				"M22 10L23 10L23 14L22 14",
				"M22 18L22 6C22 4.89543 21.1046 4 20 4L4 4C2.89543 4 2 4.89543 2 6L2 18C2 19.1046 2.89543 20 4 20L20 20C21.1046 20 22 19.1046 22 18Z",
				"M8 12C9.10457 12 10 11.1046 10 10C10 8.89543 9.10457 8 8 8C6.89543 8 6 8.89543 6 10C6 11.1046 6.89543 12 8 12Z",
				"M16 12C17.1046 12 18 11.1046 18 10C18 8.89543 17.1046 8 16 8C14.8954 8 14 8.89543 14 10C14 11.1046 14.8954 12 16 12Z",
				"M2 10L1 10L1 14L2 14",
			].map((d, index) => (
				<path key={index} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			))}{" "}
		</>
	),
	gear: (
		<>
			{" "}
			{[
				"M14 21H16",
				"M8 21H10",
				"M12 19H12.01",
				"M18 19V17",
				"M6 19V17",
				"M20 15H20.01",
				"M13 15L11 15",
				"M4 15H4.01",
				"M22 13V11",
				"M15 13L15 11",
				"M9 13L9 11",
				"M2 13V11",
				"M20 9H20.01",
				"M13 9L11 9",
				"M4 9H4.01",
				"M18 7V5",
				"M12 5H12.01",
				"M6 7V5",
				"M14 3H16",
				"M8 3H10",
			].map((d, index) => (
				<path key={index} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			))}{" "}
		</>
	),
	grid: (
		<>
			{" "}
			{["M4 4H10V10H4Z", "M14 4H20V10H14Z", "M4 14H10V20H4Z", "M14 14H20V20H14Z"].map((d, index) => (
				<path key={index} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			))}{" "}
		</>
	),
	house: (
		<>
			{" "}
			{[
				"M12 21V17",
				"M11 2H13",
				"M21 19L21 10",
				"M3 19L3 10",
				"M5 8.00999V7.99999",
				"M7 6.00999V5.99999",
				"M9 4.00999V3.99999",
				"M15 4.00999V3.99999",
				"M17 6.00999V5.99999",
				"M19 8.00999V7.99999",
				"M5 21H19",
			].map((d, index) => (
				<path key={index} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			))}{" "}
		</>
	),
	layers: (
		<>
			{" "}
			{[
				"M13 3L11 3",
				"M9 5L8 5",
				"M16 5L15 5",
				"M6 7L5 7",
				"M19 7L18 7",
				"M3 9L2 9",
				"M22 9L21 9",
				"M6 11L5 11",
				"M19 11L18 11",
				"M9 13L8 13",
				"M16 13L15 13",
				"M3 15L2 15",
				"M13 15L11 15",
				"M22 15L21 15",
				"M6 17L5 17",
				"M19 17L18 17",
				"M9 19L8 19",
				"M16 19L15 19",
				"M13 21L11 21",
			].map((d, index) => (
				<path key={index} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			))}{" "}
		</>
	),
	"media-play": (
		<>
			{" "}
			<path d="M6 4L6 20L20 12L6 4Z" />{" "}
		</>
	),
	"pixel-brackets-curly": (
		<>
			{" "}
			<path d="M12 16.01V16" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M16 16.01V16" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M8 16.01V16" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M7 3H6" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M17 3H18" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M7 21H6" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M17 21H18" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M2 12H1" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M22 12H23" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M4 10V5" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M20 10V5" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M4 19V14" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M20 19V14" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />{" "}
		</>
	),
	shield: (
		<>
			{" "}
			{[
				"M6 3H18",
				"M8.01001 20L8.00001 20",
				"M6.01001 18L6.00001 18",
				"M16.01 20L16 20",
				"M18.01 18L18 18",
				"M4 16V5",
				"M20 16V5",
				"M10 22H14",
				"M10 14.01V14",
				"M12 12.01V12",
				"M14 10.01V10",
				"M16 8.01V8",
				"M8 12.01V12",
			].map((d, index) => (
				<path key={index} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			))}{" "}
		</>
	),
	sliders: (
		<>
			{" "}
			{[
				"M14 20L16 20",
				"M22 17H22.01",
				"M2 17H8",
				"M18 16L18 18",
				"M12 16L12 18",
				"M14 14L16 14",
				"M10 10L8 10",
				"M22 7H16",
				"M2 7H2.01",
				"M12 6L12 8",
				"M6 6L6 8",
				"M10 4L8 4",
			].map((d, index) => (
				<path key={index} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			))}{" "}
		</>
	),
	"square-terminal": (
		<>
			{" "}
			{[
				"M13 16H17",
				"M19 3H5",
				"M19 21H5",
				"M3 19V5",
				"M21 19V5",
				"M11.01 12L11 12",
				"M9.01001 14L9.00001 14",
				"M7.01001 16L7.00001 16",
				"M7.01001 8L7.00001 8",
				"M9.00999 10L8.99999 10",
			].map((d, index) => (
				<path key={index} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			))}{" "}
		</>
	),
} satisfies Record<string, ReactNode>

type SidebarIconName = keyof typeof icons

/**
 * Sidebar names come from doc frontmatter, so an unknown one is expected, not a bug — and since
 * the name is arbitrary text, `in` is the wrong test: it would accept `__proto__`, `constructor`
 * and every other inherited name, and hand the SVG a function to render.
 */
function isSidebarIconName(name: string): name is SidebarIconName {
	return Object.hasOwn(icons, name)
}

export function sidebarIcon(name: string | undefined) {
	const icon = name !== undefined && isSidebarIconName(name) ? icons[name] : undefined
	if (!icon) return undefined
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true" focusable="false">
			{icon}
		</svg>
	)
}
