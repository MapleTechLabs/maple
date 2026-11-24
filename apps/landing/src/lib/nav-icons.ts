import type { IconNode } from "@maple/views/ui/icon-node"
import type { IconName } from "@maple/views/ui/icons.generated"
import type { PillarIcon } from "./feature-pillars"

/**
 * The nav's icons (Product pillars, then Resources), drawn with `iconNode` from inlined trees:
 * the `icons.generated.ts` registry is 90 kB gzip and the nav loads on every page.
 */

const NetworkNodesIcon: IconNode = [
	"svg",
	[
		["xmlns", "http://www.w3.org/2000/svg"],
		["viewBox", "0 0 24 24"],
		["width", "7777"],
		["height", "7777"],
		["class", "__icon_class__"],
		["fill", "none"],
		["aria-hidden", "true"],
	],
	[
		[
			"path",
			[
				["d", "M11 2.00001H13"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M11 8.00001H13"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M15 4L15 6"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M9 4L9 6"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M19 14H21"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M3.00002 14H5.00002"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M19 20H21"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M3.00002 20H5.00002"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M23 16L23 18"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M7 16L7 18"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M17 16L17 18"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M1 16L1 18"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M4.01003 10L4.00003 10"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M20 10L20.01 10"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M10 21L10.01 21"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M14 21L14.01 21"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M12 22L12.01 22"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M5.01003 8L5.00003 8"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M19 8L19.01 8"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
	],
]

const FileIcon: IconNode = [
	"svg",
	[
		["xmlns", "http://www.w3.org/2000/svg"],
		["viewBox", "0 0 24 24"],
		["width", "7777"],
		["height", "7777"],
		["class", "__icon_class__"],
		["fill", "none"],
		["aria-hidden", "true"],
	],
	[
		[
			"path",
			[
				["d", "M8 18H16"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M8 14L11 14"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M12 4V10H8"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M4 20L4 10"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M20 20L20 4"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M12 2L18 2"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M6 22L18 22"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M6 8H6.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M8 6H8.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M10 4H10.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
	],
]

const ChartLineIcon: IconNode = [
	"svg",
	[
		["xmlns", "http://www.w3.org/2000/svg"],
		["viewBox", "0 0 24 24"],
		["width", "7777"],
		["height", "7777"],
		["class", "__icon_class__"],
		["fill", "none"],
		["aria-hidden", "true"],
	],
	[
		[
			"path",
			[
				["d", "M2 15.01V15"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M4 13.01V13"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M6 11.01V11"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M8 9.01V9"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M10 11.01V11"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M12 13.01V13"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M14 15.01V15"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M16 13.01V13"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M18 11.01V11"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M20 9.01V9"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M22 7.01V7"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
	],
]

const CircleXmarkIcon: IconNode = [
	"svg",
	[
		["xmlns", "http://www.w3.org/2000/svg"],
		["viewBox", "0 0 24 24"],
		["width", "7777"],
		["height", "7777"],
		["class", "__icon_class__"],
		["fill", "none"],
		["aria-hidden", "true"],
	],
	[
		[
			"path",
			[
				["d", "M8 2L16 2"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M8 22L16 22"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M2 8L2 16"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M22 8L22 16"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M6 4L6 4.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M4 6L4 6.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M18 4L18 4.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M20 6L20 6.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M6 20L6 20.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M4 18L4 18.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M18 20L18 20.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M20 18L20 18.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M9 9L15 15"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M15 9L9 15"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
	],
]

const PlayRotateClockwiseIcon: IconNode = [
	"svg",
	[
		["xmlns", "http://www.w3.org/2000/svg"],
		["viewBox", "0 0 24 24"],
		["width", "7777"],
		["height", "7777"],
		["class", "__icon_class__"],
		["fill", "none"],
		["aria-hidden", "true"],
	],
	[
		[
			"path",
			[
				["d", "M4 6L4 6.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M6 4L6 4.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M20.01 6L20 6"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M18.01 4L18 4"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M20.01 18L20 18"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M18.01 20L18 20"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M6.01001 20L6.00001 20"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M4.01001 18L4.00001 18"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M2 8L2 16"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M22 14L22 16"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M8 2L16 2"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M8 22L16 22"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M22 8V4"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M17 12.01V12"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M14 10H15"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M14 14H15"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M12 8H9L9 16L12 16"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
	],
]

const BellIcon: IconNode = [
	"svg",
	[
		["xmlns", "http://www.w3.org/2000/svg"],
		["viewBox", "0 0 24 24"],
		["width", "7777"],
		["height", "7777"],
		["class", "__icon_class__"],
		["fill", "none"],
		["aria-hidden", "true"],
	],
	[
		[
			"path",
			[
				["d", "M9 20H9.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M15 20H15.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M16 4H16.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M8 4H8.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M11 22H13"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M10 2H14"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M21 16L21 14"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M3 16L3 14"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M18 5.99999L18 12L19 12"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M6 6L6 12L5 12"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M5 18H19"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
	],
]

const GlobeIcon: IconNode = [
	"svg",
	[
		["xmlns", "http://www.w3.org/2000/svg"],
		["viewBox", "0 0 24 24"],
		["width", "7777"],
		["height", "7777"],
		["class", "__icon_class__"],
		["fill", "none"],
		["aria-hidden", "true"],
	],
	[
		[
			"path",
			[
				["d", "M18 11L22 11"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M16 17L16 18"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M10 16.01L10 16"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M14 15.01L14 15"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M16 13.01L16 13"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M12 8.00999L12 7.99999"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M10 10.01L10 9.99999"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M8 6L10 6"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M8 12L7 12"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M5 14L2 14"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M18 4L17.99 4"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M20 6L19.99 6"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M18 20.01L18 20"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M20 18.01L20 18"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M6 20.01L6 20"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M4 18.01L4 18"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M4 6.01001L4 6.00001"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M6 4.01001L6 4.00001"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M16 22L8 22"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M16 2L8 2"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M22 8L22 16"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M2 8L2 16"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
	],
]

const SparkleIcon: IconNode = [
	"svg",
	[
		["xmlns", "http://www.w3.org/2000/svg"],
		["viewBox", "0 0 24 24"],
		["width", "7777"],
		["height", "7777"],
		["class", "__icon_class__"],
		["fill", "none"],
		["aria-hidden", "true"],
	],
	[
		[
			"path",
			[
				["d", "M17 7V7.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M13 7V7.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M13 11V11.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M17 11V11.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M15 13V17"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M15 1V5"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M11.01 8.99L9.01 8.99"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M21.01 8.99L19.01 8.99"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M9.01 17L9 17"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M3.01 6L3 6"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M5.01 17L5 17"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M7 13L7 15"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M7 19L7 21"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
	],
]

const PullRequestIcon: IconNode = [
	"svg",
	[
		["xmlns", "http://www.w3.org/2000/svg"],
		["viewBox", "0 0 24 24"],
		["width", "7777"],
		["height", "7777"],
		["class", "__icon_class__"],
		["fill", "none"],
		["aria-hidden", "true"],
	],
	[
		[
			"path",
			[
				["d", "M6.5 2H7.5"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M6.5 7H7.5"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M9.5 4V5"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M4.5 4V5"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M7 7V17"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M6.5 17H7.5"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M6.5 22H7.5"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M9.5 19V20"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M4.5 19V20"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M16.5 17H17.5"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M16.5 22H17.5"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M19.5 19V20"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M14.5 19V20"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M12 5L12 5.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M14 3V7"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M15 5H17V16"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
	],
]

const BookBookmarkIcon: IconNode = [
	"svg",
	[
		["xmlns", "http://www.w3.org/2000/svg"],
		["viewBox", "0 0 24 24"],
		["width", "7777"],
		["height", "7777"],
		["class", "__icon_class__"],
		["fill", "none"],
		["aria-hidden", "true"],
	],
	[
		[
			"path",
			[
				["d", "M15.5 21V20.99"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M13 17V22H14"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M18 17V22H17"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M8 7.01V7"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M8 12.01V12"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M6 2H18"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M20 4V15"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M4 4V19"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M6 21H9"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M4 17H18"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
	],
]

const PenWritingIcon: IconNode = [
	"svg",
	[
		["xmlns", "http://www.w3.org/2000/svg"],
		["viewBox", "0 0 24 24"],
		["width", "7777"],
		["height", "7777"],
		["class", "__icon_class__"],
		["fill", "none"],
		["aria-hidden", "true"],
	],
	[
		[
			"path",
			[
				["d", "M5 15H5.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M7 13H7.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M9 11H9.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M11 9H11.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M13 7H13.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M15 5H15.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M17 3H17.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M19 5H19.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M9 19H9.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M11 17H11.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M13 21H21"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M13 15H13.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M15 13H15.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M17 11H17.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M19 9H19.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M21 7H21.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M3 17V21H7"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M15 9H15.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
	],
]

const CircleHalfDottedClockIcon: IconNode = [
	"svg",
	[
		["xmlns", "http://www.w3.org/2000/svg"],
		["viewBox", "0 0 24 24"],
		["width", "7777"],
		["height", "7777"],
		["class", "__icon_class__"],
		["fill", "none"],
		["aria-hidden", "true"],
	],
	[
		[
			"path",
			[
				["d", "M20 6L20 6.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M18 4L18 4.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M22 8L22 16"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M16 2L12 2"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M12 22H16"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M18.01 20L18 20"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M20.01 18L20 18"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M12.0001 12L12.0001 8"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-miterlimit", "10"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M16.01 16L16 16"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M14.01 14L14 14"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M2.00507 11.9951L2.00497 11.9951"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M5 5L5 5.0001"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M5 19L5 19.0001"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
	],
]

const UsersIcon: IconNode = [
	"svg",
	[
		["xmlns", "http://www.w3.org/2000/svg"],
		["viewBox", "0 0 24 24"],
		["width", "7777"],
		["height", "7777"],
		["class", "__icon_class__"],
		["fill", "none"],
		["aria-hidden", "true"],
	],
	[
		[
			"path",
			[
				["d", "M7 4H9"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-miterlimit", "10"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M7 10H9"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-miterlimit", "10"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M11 6L11 8"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-miterlimit", "10"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M5 6L5 8"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-miterlimit", "10"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M17.5 4H18.5"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-miterlimit", "10"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M17.5 9H18.5"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-miterlimit", "10"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M20.5 6L20.5 7"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-miterlimit", "10"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M15.5 6L15.5 7"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-miterlimit", "10"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M5 14H11"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-miterlimit", "10"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M16 13H20"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-miterlimit", "10"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M1 18V20H15V18"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-miterlimit", "10"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M19 18H22V15"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-miterlimit", "10"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M3 16H3.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M13 16H13.01"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
	],
]

const RoadmapIcon: IconNode = [
	"svg",
	[
		["xmlns", "http://www.w3.org/2000/svg"],
		["viewBox", "0 0 24 24"],
		["width", "7777"],
		["height", "7777"],
		["class", "__icon_class__"],
		["fill", "none"],
		["aria-hidden", "true"],
	],
	[
		[
			"path",
			[
				["d", "M16 5V12"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M14 3H6"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M14 14H6"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M4 5.01V5"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M4 12.01V12"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M2 7V10"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M8 18V19"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M10 21H18"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M20 19.01V19"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M20 12.01V12"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M22 14V17"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
	],
]

const PlugIcon: IconNode = [
	"svg",
	[
		["xmlns", "http://www.w3.org/2000/svg"],
		["viewBox", "0 0 24 24"],
		["width", "7777"],
		["height", "7777"],
		["class", "__icon_class__"],
		["fill", "none"],
		["aria-hidden", "true"],
	],
	[
		[
			"path",
			[
				["d", "M16 2V7"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-miterlimit", "10"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M8 2V7"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-miterlimit", "10"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M18 15.01V15"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M6 15.01V15"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M4 13V7H20V13"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M10 21H14"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M16 19V17"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
		[
			"path",
			[
				["d", "M8 19V17"],
				["stroke", "currentColor"],
				["stroke-width", "2"],
				["stroke-linecap", "square"],
			],
			[],
		],
	],
]

export const NAV_ICONS = {
	NetworkNodesIcon,
	FileIcon,
	ChartLineIcon,
	CircleXmarkIcon,
	PlayRotateClockwiseIcon,
	BellIcon,
	GlobeIcon,
	SparkleIcon,
	PullRequestIcon,
} as const satisfies Readonly<Record<PillarIcon, IconNode>>

/** The Resources menu's icons, one per link, from the same Nucleo Pixel Essential set. */
export const RESOURCE_ICONS = {
	BookBookmarkIcon,
	PenWritingIcon,
	CircleHalfDottedClockIcon,
	UsersIcon,
	RoadmapIcon,
	PlugIcon,
} as const satisfies Readonly<Partial<Record<IconName, IconNode>>>

export type ResourceIcon = keyof typeof RESOURCE_ICONS
