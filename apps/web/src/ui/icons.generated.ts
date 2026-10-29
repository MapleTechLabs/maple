// Icon element trees. Add new icons here by hand.
// Each icon is [tag, attributes, children]; "7777" marks `size`, "__icon_class__" the className
// and "__icon_id__" an icon's own `useId`.

export const ICON_SIZE_MARK = "7777"
export const ICON_CLASS_MARK = "__icon_class__"
export const ICON_ID_MARK = "__icon_id__"

export type IconTag =
	| "svg"
	| "path"
	| "g"
	| "line"
	| "circle"
	| "rect"
	| "polyline"
	| "polygon"
	| "ellipse"
	| "defs"
	| "linearGradient"
	| "stop"

export type IconNode = readonly [IconTag, ReadonlyArray<readonly [string, string]>, ReadonlyArray<IconNode>]

export const ICON_TREES = {
	AlertWarningIcon: [
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
					["d", "M4 21H20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 17L22 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 17H12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 17L2 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 13L20 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 13L4 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 9L18 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 13V9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 9L6 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 5L16 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 5L8 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 3H14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ArrowLeftIcon: [
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
					["d", "M3 12L3 12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 14L5 14.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 16L7 16.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 18L9 18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 10L5 10.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 8L7 8.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 6L9 6.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 12L21 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ArrowRightIcon: [
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
					["d", "M21 12L21 12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 14L19 14.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 16L17 16.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 18L15 18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 10L19 10.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 8L17 8.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 6L15 6.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 12L3 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ArrowRotateAnticlockwiseIcon: [
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
					["d", "M3.98999 6L3.99999 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5.98999 4L5.99999 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3.98999 18L3.99999 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5.98999 20L5.99999 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17.99 20L18 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19.99 18L20 18"],
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
					["d", "M2 8V4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ArrowRotateClockwiseIcon: [
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
		],
	],
	ArrowUpDownIcon: [
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
					["d", "M7 3L7 3.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 5L5 5.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 5L9 5.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 7L3 7.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 7L11 7.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 5V21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 21L17 21.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 19L15 19.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 19L19 19.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 17L13 17.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 17L21 17.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 3V19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ArrowTrendDownIcon: [
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
					["d", "M2 20H22"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 13H22V7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2.01001 5L2.00001 5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4.01001 7L4.00001 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6.01001 9L6.00001 9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8.01001 11L8.00001 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10.01 9L10 9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12.01 7L12 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14.01 5L14 5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16.01 7L16 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18.01 9L18 9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20.01 11L20 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ArrowTrendUpIcon: [
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
					["d", "M16 5H22V11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 20H22"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2.01001 13L2.00001 13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4.01001 11L4.00001 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6.01001 9L6.00001 9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8.01001 7L8.00001 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10.01 9L10 9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12.01 11L12 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14.01 13L14 13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16.01 11L16 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18.01 9L18 9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20.01 7L20 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	AppleIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701",
					],
				],
				[],
			],
		],
	],
	AwsIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M6.763 11.212c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 01-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 01-.287-.375 6.18 6.18 0 01-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.39-.384-.59-.894-.59-1.533 0-.678.24-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103-.295.072-.583.16-.862.272-.09.04-.184.075-.28.104a.488.488 0 01-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 01.224-.167 4.577 4.577 0 011.005-.36 4.84 4.84 0 011.246-.151c.95 0 1.644.216 2.091.647.44.43.662 1.085.662 1.963v2.586h.016zm-3.24 1.214c.263 0 .534-.048.822-.144a1.78 1.78 0 00.758-.51 1.27 1.27 0 00.272-.512c.047-.191.08-.423.08-.694v-.335a6.66 6.66 0 00-.735-.136 6.02 6.02 0 00-.75-.048c-.535 0-.926.104-1.19.32-.263.215-.39.518-.39.917 0 .375.095.655.295.846.191.2.47.296.838.296zm6.41.862c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.311L7.586 6.726a1.398 1.398 0 01-.072-.32c0-.128.064-.2.191-.2h.783c.151 0 .255.025.31.08.065.048.113.16.16.312l1.342 5.284 1.245-5.284c.04-.16.088-.264.151-.312a.549.549 0 01.32-.08h.638c.152 0 .256.025.32.08.063.048.12.16.151.312l1.261 5.348 1.381-5.348c.048-.16.104-.264.16-.312a.52.52 0 01.311-.08h.743c.127 0 .2.065.2.2 0 .04-.009.08-.017.128a1.137 1.137 0 01-.056.2l-1.923 6.17c-.048.16-.104.263-.168.311a.51.51 0 01-.303.08h-.687c-.15 0-.255-.024-.32-.08-.063-.056-.119-.16-.15-.32L12.32 7.747l-1.23 5.14c-.04.16-.087.264-.15.32-.065.056-.177.08-.32.08l-.686.001zm10.256.215c-.415 0-.83-.048-1.229-.143-.399-.096-.71-.2-.918-.32-.128-.071-.215-.151-.247-.223a.563.563 0 01-.048-.224v-.407c0-.167.064-.247.183-.247.048 0 .096.008.144.024.048.016.12.048.2.08.271.12.566.215.878.279.32.064.63.096.95.096.502 0 .894-.088 1.165-.264a.86.86 0 00.415-.758.777.777 0 00-.215-.559c-.144-.151-.416-.287-.807-.415l-1.157-.36c-.583-.183-1.014-.454-1.277-.813a1.902 1.902 0 01-.4-1.158c0-.335.073-.63.216-.886.144-.255.335-.479.575-.654.24-.184.51-.32.83-.415.32-.096.655-.136 1.006-.136.175 0 .36.008.535.032.183.024.35.056.518.088.16.04.312.08.455.127.144.048.256.096.336.144a.69.69 0 01.24.2.43.43 0 01.071.263v.375c0 .168-.064.256-.184.256a.83.83 0 01-.303-.096 3.652 3.652 0 00-1.532-.311c-.455 0-.815.071-1.062.223-.248.152-.375.383-.375.71 0 .224.08.416.24.567.16.152.454.304.877.44l1.134.358c.574.184.99.44 1.237.767.247.327.367.702.367 1.117 0 .343-.072.655-.207.926a2.157 2.157 0 01-.583.703c-.248.2-.543.343-.886.447-.36.111-.734.167-1.142.167z",
					],
				],
				[],
			],
			[
				"path",
				[
					["fill", "#FF9900"],
					[
						"d",
						"M.378 15.475c3.384 1.963 7.56 3.153 11.877 3.153 2.914 0 6.114-.607 9.06-1.852.44-.2.814.287.383.607-2.626 1.94-6.442 2.969-9.722 2.969-4.598 0-8.74-1.7-11.87-4.526-.247-.223-.024-.527.272-.351zm23.531-.2c.287.36-.08 2.826-1.485 4.007-.215.184-.423.088-.327-.151l.175-.439c.343-.88.802-2.198.52-2.555-.336-.43-2.22-.207-3.074-.103-.255.032-.295-.192-.063-.36 1.5-1.053 3.967-.75 4.254-.399z",
					],
				],
				[],
			],
		],
	],
	AzureIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 128 128"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["aria-hidden", "true"],
		],
		[
			[
				"defs",
				[],
				[
					[
						"linearGradient",
						[
							["id", "__icon_id__-a"],
							["x1", "60.919"],
							["y1", "9.602"],
							["x2", "18.667"],
							["y2", "134.423"],
							["gradientUnits", "userSpaceOnUse"],
						],
						[
							["stop", [["stop-color", "#114A8B"]], []],
							[
								"stop",
								[
									["offset", "1"],
									["stop-color", "#0669BC"],
								],
								[],
							],
						],
					],
					[
						"linearGradient",
						[
							["id", "__icon_id__-b"],
							["x1", "74.117"],
							["y1", "67.772"],
							["x2", "64.344"],
							["y2", "71.076"],
							["gradientUnits", "userSpaceOnUse"],
						],
						[
							["stop", [["stop-opacity", ".3"]], []],
							[
								"stop",
								[
									["offset", ".071"],
									["stop-opacity", ".2"],
								],
								[],
							],
							[
								"stop",
								[
									["offset", ".321"],
									["stop-opacity", ".1"],
								],
								[],
							],
							[
								"stop",
								[
									["offset", ".623"],
									["stop-opacity", ".05"],
								],
								[],
							],
							[
								"stop",
								[
									["offset", "1"],
									["stop-opacity", "0"],
								],
								[],
							],
						],
					],
					[
						"linearGradient",
						[
							["id", "__icon_id__-c"],
							["x1", "68.742"],
							["y1", "5.961"],
							["x2", "115.122"],
							["y2", "129.525"],
							["gradientUnits", "userSpaceOnUse"],
						],
						[
							["stop", [["stop-color", "#3CCBF4"]], []],
							[
								"stop",
								[
									["offset", "1"],
									["stop-color", "#2892DF"],
								],
								[],
							],
						],
					],
				],
			],
			[
				"path",
				[
					[
						"d",
						"M46.09.002h40.685L44.541 125.137a6.485 6.485 0 01-6.146 4.413H6.733a6.482 6.482 0 01-5.262-2.699 6.474 6.474 0 01-.876-5.848L39.944 4.414A6.488 6.488 0 0146.09 0z",
					],
					["fill", "url(#__icon_id__-a)"],
					["transform", "translate(.587 4.468) scale(.91904)"],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M97.28 81.607H37.987a2.743 2.743 0 00-1.874 4.751l38.1 35.562a5.991 5.991 0 004.087 1.61h33.574z",
					],
					["fill", "#0078d4"],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M46.09.002A6.434 6.434 0 0039.93 4.5L.644 120.897a6.469 6.469 0 006.106 8.653h32.48a6.942 6.942 0 005.328-4.531l7.834-23.089 27.985 26.101a6.618 6.618 0 004.165 1.519h36.396l-15.963-45.616-46.533.011L86.922.002z",
					],
					["fill", "url(#__icon_id__-b)"],
					["transform", "translate(.587 4.468) scale(.91904)"],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M98.055 4.408A6.476 6.476 0 0091.917.002H46.575a6.478 6.478 0 016.137 4.406l39.35 116.594a6.476 6.476 0 01-6.137 8.55h45.344a6.48 6.48 0 006.136-8.55z",
					],
					["fill", "url(#__icon_id__-c)"],
					["transform", "translate(.587 4.468) scale(.91904)"],
				],
				[],
			],
		],
	],
	DockerIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "#2496ED"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.082.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288z",
					],
				],
				[],
			],
		],
	],
	FolderIcon: [
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
					["d", "M20 8H14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 20H20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 4H10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 18L2 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 18L22 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"rect",
				[
					["x", "11"],
					["y", "5"],
					["width", "2"],
					["height", "2"],
					["fill", "currentColor"],
				],
				[],
			],
		],
	],
	LinuxIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 48 48"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					["fill", "#ECEFF1"],
					[
						"d",
						"m20.1 16.2l.1 2.3l-1.6 3l-2.5 4.9l-.5 4.1l1.8 5.8l4.1 2.3h6.2l5.8-4.4l2.6-6.9l-6-7.3l-1.7-4.1z",
					],
				],
				[],
			],
			[
				"path",
				[
					["fill", "#263238"],
					[
						"d",
						"M34.3 21.9c-1.6-2.3-2.9-3.7-3.6-6.6s.2-2.1-.4-4.6c-.3-1.3-.8-2.2-1.3-2.9c-.6-.7-1.3-1.1-1.7-1.2c-.9-.5-3-1.3-5.6.1c-2.7 1.4-2.4 4.4-1.9 10.5c0 .4-.1.9-.3 1.3c-.4.9-1.1 1.7-1.7 2.4c-.7 1-1.4 2-1.9 3.1c-1.2 2.3-2.3 5.2-2 6.3c.5-.1 6.8 9.5 6.8 9.7c.4-.1 2.1-.1 3.6-.1c2.1-.1 3.3-.2 5 .2c0-.3-.1-.6-.1-.9c0-.6.1-1.1.2-1.8c.1-.5.2-1 .3-1.6c-1 .9-2.8 1.9-4.5 2.2c-1.5.3-4-.2-5.2-1.7c.1 0 .3 0 .4-.1c.3-.1.6-.2.7-.4c.3-.5.1-1-.1-1.3s-1.7-1.4-2.4-2s-1.1-.9-1.5-1.3l-.8-.8c-.2-.2-.3-.4-.4-.5c-.2-.5-.3-1.1-.2-1.9c.1-1.1.5-2 1-3c.2-.4.7-1.2.7-1.2s-1.7 4.2-.8 5.5c0 0 .1-1.3.5-2.6c.3-.9.8-2.2 1.4-2.9s2.1-3.3 2.2-4.9c0-.7.1-1.4.1-1.9c-.4-.4 6.6-1.4 7-.3c.1.4 1.5 4 2.3 5.9c.4.9.9 1.7 1.2 2.7c.3 1.1.5 2.6.5 4.1c0 .3 0 .8-.1 1.3c.2 0 4.1-4.2-.5-7.7c0 0 2.8 1.3 2.9 3.9c.1 2.1-.8 3.8-1 4.1c.1 0 2.1.9 2.2.9c.4 0 1.2-.3 1.2-.3c.1-.3.4-1.1.4-1.4c.7-2.3-1-6-2.6-8.3",
					],
				],
				[],
			],
			[
				"g",
				[
					["fill", "#ECEFF1"],
					["transform", "translate(0 -2)"],
				],
				[
					[
						"ellipse",
						[
							["cx", "21.6"],
							["cy", "15.3"],
							["rx", "1.3"],
							["ry", "2"],
						],
						[],
					],
					[
						"ellipse",
						[
							["cx", "26.1"],
							["cy", "15.2"],
							["rx", "1.7"],
							["ry", "2.3"],
						],
						[],
					],
				],
			],
			[
				"g",
				[
					["fill", "#212121"],
					["transform", "translate(0 -2)"],
				],
				[
					[
						"ellipse",
						[
							["cx", "21.7"],
							["cy", "15.5"],
							["rx", "1.2"],
							["ry", ".7"],
							["transform", "rotate(-97.204 21.677 15.542)"],
						],
						[],
					],
					[
						"ellipse",
						[
							["cx", "26"],
							["cy", "15.6"],
							["rx", "1"],
							["ry", "1.3"],
						],
						[],
					],
				],
			],
			[
				"path",
				[
					["fill", "#FFC107"],
					[
						"d",
						"M39.3 35.6c-.4-.2-1.1-.5-1.7-1.4c-.3-.5-.2-1.9-.7-2.5c-.3-.4-.7-.2-.8-.2c-.9.2-3 1.6-4.4 0c-.2-.2-.5-.5-1-.5s-.7.2-.9.6s-.2.7-.2 1.7c0 .8 0 1.7-.1 2.4c-.2 1.7-.5 2.7-.5 3.7c0 1.1.3 1.8.7 2.1c.3.3.8.5 1.9.5s1.8-.4 2.5-1.1c.5-.5.9-.7 2.3-1.7c1.1-.7 2.8-1.6 3.1-1.9c.2-.2.5-.3.5-.9c0-.5-.4-.7-.7-.8m-20.1.3c-1-1.6-1.1-1.9-1.8-2.9c-.6-1-1.9-2.9-2.7-2.9c-.6 0-.9.3-1.3.7s-.8 1.3-1.5 1.8c-.6.5-2.3.4-2.7 1s.4 1.5.4 3c0 .6-.5 1-.6 1.4c-.1.5-.2.8 0 1.2c.4.6.9.8 4.3 1.5c1.8.4 3.5 1.4 4.6 1.5s3 0 3-2.7c.1-1.6-.8-2-1.7-3.6m1.9-18.1c-.6-.4-1.1-.8-1.1-1.4s.4-.8 1-1.3c.1-.1 1.2-1.1 2.3-1.1s2.4.7 2.9.9c.9.2 1.8.4 1.7 1.1c-.1 1-.2 1.2-1.2 1.7c-.7.2-2 1.3-2.9 1.3c-.4 0-1 0-1.4-.1c-.3-.1-.8-.6-1.3-1.1",
					],
				],
				[],
			],
			[
				"path",
				[
					["fill", "#634703"],
					[
						"d",
						"M20.9 17c.2.2.5.4.8.5c.2.1.5.2.5.2h.9c.5 0 1.2-.2 1.9-.6c.7-.3.8-.5 1.3-.7c.5-.3 1-.6.8-.7s-.4 0-1.1.4c-.6.4-1.1.6-1.7.9c-.3.1-.7.3-1 .3h-.9c-.3 0-.5-.1-.8-.2c-.2-.1-.3-.2-.4-.2c-.2-.1-.6-.5-.8-.6c0 0-.2 0-.1.1zm3-2.2c.1.2.3.2.4.3s.2.1.2.1c.1-.1 0-.3-.1-.3c0-.2-.5-.2-.5-.1m-1.6.2c0 .1.2.2.2.1c.1-.1.2-.2.3-.2c.2-.1.1-.2-.2-.2c-.2.1-.2.2-.3.3",
					],
				],
				[],
			],
			[
				"path",
				[
					["fill", "#455A64"],
					[
						"d",
						"M32 32.7v.3c.2.4.7.5 1.1.5c.6 0 1.2-.4 1.5-.8c0-.1.1-.2.2-.3c.2-.3.3-.5.4-.6c0 0-.1-.1-.1-.2c-.1-.2-.4-.4-.8-.5c-.3-.1-.8-.2-1-.2c-.9-.1-1.4.2-1.7.5c0 0 .1 0 .1.1c.2.2.3.4.3.7c.1.2 0 .3 0 .5",
					],
				],
				[],
			],
		],
	],
	MicrochipIcon: [
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
					["d", "M7 5H17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 19H17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 7V17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 7V17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 2L9 2.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 2L12 2.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 2L15 2.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 22L9 22.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 22L12 22.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 22L15 22.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 9L2 9.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 12L2 12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 15L2 15.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 9L22 9.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 12L22 12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 15L22 15.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 10H14V14H10Z"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	MicrosoftIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M0 0h11.377v11.377H0zM12.623 0H24v11.377H12.623zM0 12.623h11.377V24H0zM12.623 12.623H24V24H12.623z",
					],
				],
				[],
			],
		],
	],
	ArrowUpIcon: [
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
					["d", "M12 3H12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 5H14.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 7H16.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 9H18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 5H10.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 7H8.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 9H6.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 5L12 21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	AwsLambdaIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "#FF9900"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M2 2h20v20H2V2zm1.76 18.23h16.45V3.76H3.76v16.47zm3.51-14.91l3.47 6.17-3.87 7.15h2.49l2.58-4.88 2.74 4.88h2.54L9.82 5.32l-2.53.002z",
					],
				],
				[],
			],
		],
	],
	BellIcon: [
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
	],
	BoxArchiveIcon: [
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
					["d", "M14 12L10 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 12L21 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 5L22 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 5L2 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 12L3 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 21L5 21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 3L4 3"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 8L4 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	BracketsCurlyIcon: [
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
					["d", "M12 16.01V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 16.01V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 16.01V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 3H6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 3H18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 21H6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 21H18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 12H1"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 12H23"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 10V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 10V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 19V14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 19V14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	BranchForkIcon: [
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
					["d", "M7 12H15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 10V7"],
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
				],
				[],
			],
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
					["d", "M9.5 4L9.5 5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4.5 4L4.5 5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16.5 2H17.5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16.5 7H17.5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19.5 4L19.5 5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14.5 4L14.5 5"],
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
					["d", "M9.5 19L9.5 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4.5 19L4.5 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	PullRequestIcon: [
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
	],
	BunIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M12 22.596c6.628 0 12-4.338 12-9.688 0-3.318-2.057-6.248-5.219-7.986-1.286-.715-2.297-1.357-3.139-1.89C14.058 2.025 13.08 1.404 12 1.404c-1.097 0-2.334.785-3.966 1.821a49.92 49.92 0 0 1-2.816 1.697C2.057 6.66 0 9.59 0 12.908c0 5.35 5.372 9.687 12 9.687v.001ZM10.599 4.715c.334-.759.503-1.58.498-2.409 0-.145.202-.187.23-.029.658 2.783-.902 4.162-2.057 4.624-.124.048-.199-.121-.103-.209a5.763 5.763 0 0 0 1.432-1.977Zm2.058-.102a5.82 5.82 0 0 0-.782-2.306v-.016c-.069-.123.086-.263.185-.172 1.962 2.111 1.307 4.067.556 5.051-.082.103-.23-.003-.189-.126a5.85 5.85 0 0 0 .23-2.431Zm1.776-.561a5.727 5.727 0 0 0-1.612-1.806v-.014c-.112-.085-.024-.274.114-.218 2.595 1.087 2.774 3.18 2.459 4.407a.116.116 0 0 1-.049.071.11.11 0 0 1-.153-.026.122.122 0 0 1-.022-.083 5.891 5.891 0 0 0-.737-2.331Zm-5.087.561c-.617.546-1.282.76-2.063 1-.117 0-.195-.078-.156-.181 1.752-.909 2.376-1.649 2.999-2.778 0 0 .155-.118.188.085 0 .304-.349 1.329-.968 1.874Zm4.945 11.237a2.957 2.957 0 0 1-.937 1.553c-.346.346-.8.565-1.286.62a2.178 2.178 0 0 1-1.327-.62 2.955 2.955 0 0 1-.925-1.553.244.244 0 0 1 .064-.198.234.234 0 0 1 .193-.069h3.965a.226.226 0 0 1 .19.07c.05.053.073.125.063.197Zm-5.458-2.176a1.862 1.862 0 0 1-2.384-.245 1.98 1.98 0 0 1-.233-2.447c.207-.319.503-.566.848-.713a1.84 1.84 0 0 1 1.092-.11c.366.075.703.261.967.531a1.98 1.98 0 0 1 .408 2.114 1.931 1.931 0 0 1-.698.869v.001Zm8.495.005a1.86 1.86 0 0 1-2.381-.253 1.964 1.964 0 0 1-.547-1.366c0-.384.11-.76.32-1.079.207-.319.503-.567.849-.713a1.844 1.844 0 0 1 1.093-.108c.367.076.704.262.968.534a1.98 1.98 0 0 1 .4 2.117 1.932 1.932 0 0 1-.702.868Z",
					],
				],
				[],
			],
		],
	],
	ChartBarHorizontalIcon: [
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
					["d", "M8 16H17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 11H20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 6H12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 3V19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 21L5 21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ChartBarIcon: [
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
					["d", "M2 20H22"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 8L4 8.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 11L20 11.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 3L12 3.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 10V16H6V10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 13V16H22V13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 5V16H14V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ChartBarTrendUpIcon: [
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
					["d", "M10 14V20H14V14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 10V20H22V10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 18V20H6V18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4.01001 16L4.00001 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12.01 12L12 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2.01001 8L2.00001 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4.01001 6L4.00001 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6.01001 4L6.00001 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8.01001 6L8.00001 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10.01 8L10 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12.01 6L12 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14.01 4L14 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20.01 8L20 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ChartLineIcon: [
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
	],
	ChatBubbleIcon: [
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
					["d", "M8 11.01V11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 11.01V11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 11.01V11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 4H20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 6V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 6V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 18H20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ChatBubbleSparkleIcon: [
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
					["d", "M12 11.01V11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 11.01V11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 11.01V11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 4H20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 18H8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 18H20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 6V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 6V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 20H10.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 22H12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 20H14.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	CheckIcon: [
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
					["d", "M9.99999 18H10.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 16H12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7.99999 16H8.00999"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 14H14.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5.99999 14H6.00999"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3.99999 12H4.00999"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 6H22.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 12H16.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 10H18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 8H20.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ChevronDownIcon: [
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
					["d", "M12 16.99L12 17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 14.99L10 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 14.99L14 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 12.99L16 13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 12.99L8 13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 10.99L6 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 10.99L18 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 8.98999L20 8.99999"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 8.98999L4 8.99999"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ChevronExpandYIcon: [
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
					["d", "M12 2.01001L12 2.00001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 22L12 22.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 4.01001L10 4.00001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 20L10 20.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 4.01001L14 4.00001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 20L14 20.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 6.01001L16 6.00001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 18L16 18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 8.01001L18 8.00001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 16L18 16.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 6.01001L8 6.00001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 18L8 18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 8.01001L6 8.00001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 16L6 16.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ChevronLeftIcon: [
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
					["d", "M7.01001 12H7.00001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9.01001 10H9.00001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9.01001 14H9.00001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11.01 16H11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11.01 8H11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13.01 6H13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13.01 18H13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15.01 20H15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15.01 4H15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ChevronRightIcon: [
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
					["d", "M16.99 12H17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14.99 10H15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14.99 14H15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12.99 16H13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12.99 8H13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10.99 6H11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10.99 18H11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8.99 20H9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8.99 4H9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ChevronUpIcon: [
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
					["d", "M12 7.01001L12 7.00001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 9.01001L10 9.00001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 9.01001L14 9.00001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 11.01L16 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 11.01L8 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 13.01L6 13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 13.01L18 13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 15.01L20 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 15.01L4 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	CircleCheckIcon: [
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
					["d", "M8 12L11 15L16 9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	CircleInfoIcon: [
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
					["d", "M12 16L12 12H10"],
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
					["d", "M12 8.01V8"],
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
					["d", "M8 2L16 2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	CirclePercentageIcon: [
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
					["d", "M8 16L16 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 8H10V10H8Z"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 14H16V16H14Z"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	CircleQuestionIcon: [
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
					["d", "M9 9V8H15V11L12 13V15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 18L12 18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	CircleWarningIcon: [
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
					["d", "M12 7V13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 16L12 16.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	CircleXmarkIcon: [
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
	],
	ClickhouseIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "#FFCC00"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M21.33 10H24v4h-2.66ZM16 1.33h2.66v21.33H16Zm-5.33 0h2.66v21.33h-2.66ZM0 22.66V1.33h2.66v21.33zm5.33-21.33H8v21.33H5.33Z",
					],
				],
				[],
			],
		],
	],
	ClockIcon: [
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
					["d", "M12.0001 12L12.0001 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
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
		],
	],
	CloudflareBrandIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "#F38020"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M16.50 16.84c.1475-.5068.09-.9707-.1553-1.31-.2246-.3164-.6045-.499-1.06-.5205l-8.65-.1123a.1559.15 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.02-.084.11-.1484.20-.1562l8.73-.1123c1.03-.0489 2.16-.8868 2.55-1.91l.499-1.30c.0215-.0561.02-.1128.01-.168-.5625-2.54-2.83-4.44-5.54-4.44-2.50 0-4.62 1.61-5.38 3.86-.4927-.3658-1.11-.5625-1.79-.499-1.20.119-2.16 1.08-2.28 2.28-.0283.31-.0069.61.0635.89C1.56 13.17 0 14.77 0 16.75c0 .1748.01.3515.03.5273.01.083.08.1475.16.1475h15.98c.0909 0 .1758-.0645.20-.1553l.12-.4268zm2.75-5.56c-.0771 0-.1611 0-.2383.01-.0566 0-.1054.04-.127.09l-.3378 1.17c-.1475.50-.0918.97.1543 1.31.2256.31.6055.49 1.06.5195l1.84.1133c.0557 0 .1055.02.1329.07.0283.04.0351.10.0214.15-.0283.08-.1132.14-.204.15l-1.92.1123c-1.04.0488-2.15.8867-2.55 1.91l-.1406.35c-.0283.07.0215.14.0986.14h6.59c.0771 0 .1474-.0489.16-.126.11-.4082.17-.837.17-1.28 0-2.60-2.12-4.72-4.73-4.72",
					],
				],
				[],
			],
		],
	],
	CloudflareIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M16.50 16.84c.1475-.5068.09-.9707-.1553-1.31-.2246-.3164-.6045-.499-1.06-.5205l-8.65-.1123a.1559.15 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.02-.084.11-.1484.20-.1562l8.73-.1123c1.03-.0489 2.16-.8868 2.55-1.91l.499-1.30c.0215-.0561.02-.1128.01-.168-.5625-2.54-2.83-4.44-5.54-4.44-2.50 0-4.62 1.61-5.38 3.86-.4927-.3658-1.11-.5625-1.79-.499-1.20.119-2.16 1.08-2.28 2.28-.0283.31-.0069.61.0635.89C1.56 13.17 0 14.77 0 16.75c0 .1748.01.3515.03.5273.01.083.08.1475.16.1475h15.98c.0909 0 .1758-.0645.20-.1553l.12-.4268zm2.75-5.56c-.0771 0-.1611 0-.2383.01-.0566 0-.1054.04-.127.09l-.3378 1.17c-.1475.50-.0918.97.1543 1.31.2256.31.6055.49 1.06.5195l1.84.1133c.0557 0 .1055.02.1329.07.0283.04.0351.10.0214.15-.0283.08-.1132.14-.204.15l-1.92.1123c-1.04.0488-2.15.8867-2.55 1.91l-.1406.35c-.0283.07.0215.14.0986.14h6.59c.0771 0 .1474-.0489.16-.126.11-.4082.17-.837.17-1.28 0-2.60-2.12-4.72-4.73-4.72",
					],
				],
				[],
			],
		],
	],
	CloudflareMonoIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M16.50 16.84c.1475-.5068.09-.9707-.1553-1.31-.2246-.3164-.6045-.499-1.06-.5205l-8.65-.1123a.1559.15 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.02-.084.11-.1484.20-.1562l8.73-.1123c1.03-.0489 2.16-.8868 2.55-1.91l.499-1.30c.0215-.0561.02-.1128.01-.168-.5625-2.54-2.83-4.44-5.54-4.44-2.50 0-4.62 1.61-5.38 3.86-.4927-.3658-1.11-.5625-1.79-.499-1.20.119-2.16 1.08-2.28 2.28-.0283.31-.0069.61.0635.89C1.56 13.17 0 14.77 0 16.75c0 .1748.01.3515.03.5273.01.083.08.1475.16.1475h15.98c.0909 0 .1758-.0645.20-.1553l.12-.4268zm2.75-5.56c-.0771 0-.1611 0-.2383.01-.0566 0-.1054.04-.127.09l-.3378 1.17c-.1475.50-.0918.97.1543 1.31.2256.31.6055.49 1.06.5195l1.84.1133c.0557 0 .1055.02.1329.07.0283.04.0351.10.0214.15-.0283.08-.1132.14-.204.15l-1.92.1123c-1.04.0488-2.15.8867-2.55 1.91l-.1406.35c-.0283.07.0215.14.0986.14h6.59c.0771 0 .1474-.0489.16-.126.11-.4082.17-.837.17-1.28 0-2.60-2.12-4.72-4.73-4.72",
					],
				],
				[],
			],
		],
	],
	CodeIcon: [
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
					["d", "M12 16.01V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 16.01V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 16.01V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 3H6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 3H18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 21H6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 21H18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 12H1"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 12H23"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 10V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 10V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 19V14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 19V14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ComputerIcon: [
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
					["d", "M9 6H15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 2H17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 22H17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 20V4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 20V4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 14H12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 18H12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 16H10.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 16H14.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ChromeIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 32 32"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					["fill", "#EA4335"],
					[
						"d",
						"M9.138,14.616c.645-3.199,3.476-5.616,6.862-5.616h12.106c-2.425-4.177-6.937-7-12.106-7-4.478,0-8.461,2.121-11.026,5.403l4.164,7.213Z",
					],
				],
				[],
			],
			[
				"circle",
				[
					["cx", "16"],
					["cy", "16"],
					["r", "5.25"],
					["fill", "#4285F4"],
				],
				[],
			],
			[
				"path",
				[
					["fill", "#34A853"],
					[
						"d",
						"M18.236,22.627c-.703,.238-1.453,.373-2.236,.373-2.586,0-4.843-1.413-6.055-3.504l-.008,.004L3.885,9.017c-1.192,2.058-1.885,4.439-1.885,6.983,0,7.061,5.261,12.903,12.065,13.85l4.17-7.223Z",
					],
				],
				[],
			],
			[
				"path",
				[
					["fill", "#FBBC05"],
					[
						"d",
						"M20.615,10.75c1.459,1.284,2.385,3.159,2.385,5.25,0,1.274-.347,2.466-.945,3.496l.008,.004-6.063,10.5c7.719,0,14-6.281,14-14,0-1.857-.371-3.627-1.031-5.25h-8.355Z",
					],
				],
				[],
			],
		],
	],
	SafariIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 32 32"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["aria-hidden", "true"],
		],
		[
			[
				"circle",
				[
					["cx", "16"],
					["cy", "16"],
					["r", "14"],
					["fill", "#1B9AF7"],
				],
				[],
			],
			[
				"path",
				[
					["fill", "#FF3B30"],
					["d", "M24.5,7.5l-11.47,5.53,5.94,5.94,5.53-11.47Z"],
				],
				[],
			],
			[
				"path",
				[
					["fill", "#F5F7FA"],
					["d", "M7.5,24.5l11.47-5.53-5.94-5.94-5.53,11.47Z"],
				],
				[],
			],
		],
	],
	FirefoxIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 32 32"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "#FF7139"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M28.997,10.732c-.577-1.575-1.79-3.182-1.817-3.217-.405-.532-.847-1.033-1.32-1.498-.331-.341-.683-.659-1.052-.952-.225-.194-.459-.378-.701-.551-.431-.321-.902-.61-1.413-.862-.126-.066-.253-.13-.38-.191-1.002-.485-2.048-.868-3.129-1.106-.144-.032-.288-.061-.433-.088-.721-.137-1.455-.216-2.196-.231-.114-.002-.226-.003-.337-.003-.969-.001-1.925,.097-2.831,.287-1.989,.419-3.738,1.277-4.844,2.351,.002,0,.003-.002,.005-.003-.002,.002-.003,.003-.005,.005,.002-.002,.005-.004,.008-.007,.002-.001,.005-.003,.007-.004-.002,.001-.004,.003-.005,.004,.004-.003,.009-.006,.015-.01,.828-.496,1.97-.898,2.786-1.103,4.157-1.016,8.225,.258,10.911,2.828,.577,.552,1.095,1.171,1.515,1.852,1.713,2.779,1.551,6.273,.215,8.333-.992,1.531-3.118,2.967-5.1,2.951,.04,.002,.08,.004,.12,.005-.065-.001-.13-.004-.196-.008-.002,0-.004,0-.006,0-.945-.057-1.762-.277-2.452-.614-3.148-1.536-3.635-5.496-1.394-7.401,0,0,0,0,0,0h0c-.737-.158-2.123,.152-3.087,1.59-.865,1.291-.817,3.285-.283,4.699-.325-.681-.563-1.374-.687-2.211-.676-4.552,2.301-8.45,5.121-9.547,.068-.026,.135-.051,.203-.074h0s0,0,0,0c-.606-.528-1.57-.836-2.691-.889-2.542-.092-7.377,1.072-9.177,6.848,.023-.969,.682-3.287,1.448-4.716,.002-.005,.005-.009,.007-.014,0,0,0,0,0,0,0,0,0,0,0,0-.323,.167-.675,.454-1.024,.816-.698,.726-1.382,1.755-1.788,2.732-.675,1.624-1.014,3.492-1.008,5.362,.002,.563,.034,1.126,.099,1.683,.003,.028,.007,.057,.01,.085,.016,.142,.032,.284,.05,.425,.001,.01,.003,.021,.004,.031,1.127,6.613,6.884,11.647,13.818,11.647,7.742,0,14.019-6.277,14.019-14.019,0-1.843-.356-3.604-1.003-5.216Z",
					],
				],
				[],
			],
		],
	],
	EdgeIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 32 32"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					["fill", "#35C1F1"],
					[
						"d",
						"M13.563,28.373c-.975-.603-1.821-1.398-2.488-2.335-1.039-1.449-1.654-3.245-1.654-5.182,0-2.86,1.334-5.387,3.373-6.991,.462-.359,1.064-.731,1.5-.936,.346-.167,.923-.449,1.693-.436,1.282,.013,2.257,.667,2.808,1.411,.423,.577,.68,1.27,.692,2.039,0-.026,2.667-8.697-8.745-8.697C5.972,7.246,2.022,11.8,2.022,15.802c0,2.527,.59,4.554,1.321,6.119,1.641,3.489,4.681,6.196,8.399,7.388,1.346,.436,2.783,.667,4.27,.667,1.539,0,3.026-.257,4.424-.718-.782,.244-1.616,.385-2.488,.385-1.616-.013-3.103-.475-4.386-1.27Z",
					],
				],
				[],
			],
			[
				"path",
				[
					["fill", "#0C59A4"],
					[
						"d",
						"M27.259,22.818c-.372,.192-.757,.359-1.154,.513-1.205,.449-2.526,.706-3.924,.706-5.168,0-9.669-3.553-9.669-8.12,0-1.283,.744-2.399,1.795-2.976-.017,0-.031,.004-.048,.005-.433,.208-1.015,.568-1.466,.918-2.039,1.603-3.373,4.13-3.373,6.991,0,1.937,.616,3.733,1.654,5.182,.667,.936,1.513,1.732,2.488,2.335,1.282,.795,2.77,1.257,4.386,1.27,.419,0,.827-.036,1.226-.097,.098-.019,.193-.039,.288-.06,.175-.033,.345-.077,.515-.121,.154-.04,.315-.08,.445-.12,.051-.013,.09-.026,.141-.051,3.026-1.052,5.591-3.104,7.271-5.772,.244-.372-.18-.821-.577-.603Z",
					],
				],
				[],
			],
			[
				"path",
				[
					["fill", "#0078D4"],
					[
						"d",
						"M18.654,18.265c-.09,.115-.359,.269-.359,.616,0,.282,.18,.564,.513,.795,1.577,1.09,4.527,.949,4.539,.949,1.218,0,2.321-.346,3.308-.911,.449-.257,.859-.577,1.231-.924,1.282-1.219,2.065-2.937,2.09-4.849,.026-2.45-.872-4.079-1.244-4.797-2.308-4.541-7.296-7.145-12.733-7.145C8.344,2,2.125,8.157,2.022,15.789c.051-3.989,4.014-7.222,8.733-7.222,.385,0,2.565,.039,4.591,1.103,1.782,.936,2.719,2.065,3.373,3.194,.68,1.167,.795,2.642,.795,3.22s-.308,1.462-.859,2.181Z",
					],
				],
				[],
			],
		],
	],
	OperaIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 32 32"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "#FF1B2D"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M30,16h0c0,4.147-1.803,7.872-4.669,10.436-3.591,1.75-6.938,.525-8.046-.239,3.527-.774,6.192-5.039,6.192-10.197s-2.665-9.423-6.192-10.197c1.108-.764,4.455-1.989,8.046-.239,2.865,2.564,4.669,6.289,4.669,10.436h0Z",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M11.392,8.111c-1.548,1.827-2.551,4.528-2.619,7.56v.66c.068,3.031,1.071,5.733,2.619,7.56,2.008,2.608,4.994,4.262,8.328,4.262,2.051,0,3.969-.626,5.611-1.714-2.478,2.214-5.747,3.561-9.331,3.561-.223,0-.445-.006-.667-.016-7.423-.348-13.333-6.476-13.333-13.984,0-7.732,6.269-14,14-14,.018,0,.035,0,.052,0,3.564,.013,6.814,1.358,9.278,3.563-1.641-1.088-3.56-1.715-5.611-1.715-3.333,0-6.318,1.654-8.326,4.262Z",
					],
				],
				[],
			],
		],
	],
	MobileIcon: [
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
					["d", "M9 18H15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 6L13 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 2H17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 22H17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 20V4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 20V4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	TabletIcon: [
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
					["d", "M6 3H18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 21H18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 19V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 19V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 17H12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	MediaPlayIcon: [
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
					["d", "M20.01 12L20 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 10L17 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 8L14 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 6L11 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 18L11 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 16L14 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 14L17 14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 20L6 20L6 4L9 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ArrowPathIcon: [
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
					["d", "M3.98999 6L3.99999 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5.98999 4L5.99999 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3.98999 18L3.99999 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5.98999 20L5.99999 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17.99 20L18 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19.99 18L20 18"],
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
					["d", "M2 8V4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	CursorIcon: [
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
					["d", "M19 8H16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 8H16"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 8H16"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 8H16"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 19L8 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 19L8 16"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 19L8 16"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 19L8 16"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 14L6 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 14L6 11"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 14L6 11"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 14L6 11"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 9L4 4L9 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 9L4 4L9 4"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 9L4 4L9 4"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 9L4 4L9 4"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 6H11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 6H11"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 6H11"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 6H11"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 10V11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 10V11"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 10V11"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 10V11"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 15V19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 15V19"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 15V19"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 15V19"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 21L10 21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 21L10 21"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 21L10 21"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 21L10 21"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 13L15 13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 13L15 13"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 13L15 13"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 13L15 13"],
					["stroke-opacity", "0.2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ArrowRightFromLineIcon: [
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
					["d", "M19 10V14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 21L3 3"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 12L21 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 16.01L17 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 18.01L15 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 8.01001L17 8.00001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 6.01001L15 6.00001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	CursorPointerIcon: [
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
					["d", "M10 2L10 2.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 4V12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 4V9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 9H18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 11V17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 12L6 12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 14V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 18L6 18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 20L8 20.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 21H16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 19L18 19.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 9V11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	FingerprintIcon: [
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
					["d", "M4 13V18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 6V12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 8V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"rect",
				[
					["x", "5"],
					["y", "3"],
					["width", "2"],
					["height", "2"],
					["fill", "currentColor"],
				],
				[],
			],
			[
				"rect",
				[
					["x", "5"],
					["y", "19"],
					["width", "2"],
					["height", "2"],
					["fill", "currentColor"],
				],
				[],
			],
			[
				"rect",
				[
					["x", "7"],
					["y", "21"],
					["width", "2"],
					["height", "2"],
					["fill", "currentColor"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 22H14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"rect",
				[
					["x", "17"],
					["y", "3"],
					["width", "2"],
					["height", "2"],
					["fill", "currentColor"],
				],
				[],
			],
			[
				"rect",
				[
					["x", "17"],
					["y", "13"],
					["width", "2"],
					["height", "2"],
					["fill", "currentColor"],
				],
				[],
			],
			[
				"rect",
				[
					["x", "13"],
					["y", "15"],
					["width", "2"],
					["height", "2"],
					["fill", "currentColor"],
				],
				[],
			],
			[
				"rect",
				[
					["x", "11"],
					["y", "19"],
					["width", "2"],
					["height", "2"],
					["fill", "currentColor"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 2H14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 6H14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 8V10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 11V14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 6V9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 18H19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	PixelBracketsCurlyIcon: [
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
					["d", "M12 16.01V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 16.01V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 16.01V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 3H6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 3H18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 21H6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 21H18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 12H1"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 12H23"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 10V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 10V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 19V14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 19V14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	PixelCrosshairsIcon: [
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
					["d", "M12 2V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 22V19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22.005 11.995L19.005 11.995"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2.005 11.995L5.005 11.995"],
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
					["d", "M8 22L16 22"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	PixelNodesIcon: [
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
					["stroke-miterlimit", "10"],
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
					["stroke-miterlimit", "10"],
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
					["stroke-miterlimit", "10"],
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
					["stroke-miterlimit", "10"],
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
					["stroke-miterlimit", "10"],
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
					["stroke-miterlimit", "10"],
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
					["stroke-miterlimit", "10"],
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
					["stroke-miterlimit", "10"],
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
					["stroke-miterlimit", "10"],
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
					["stroke-miterlimit", "10"],
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
					["stroke-miterlimit", "10"],
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
					["stroke-miterlimit", "10"],
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
	],
	PixelSparkleIcon: [
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
					["d", "M11.005 8.995L9.005 8.995"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21.005 8.995L19.005 8.995"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9.01001 17L9.00001 17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3.01001 6L3.00001 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5.01001 17L5.00001 17"],
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
	],
	PixelWindowIcon: [
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
					["d", "M5 21L19 21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 14L3 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 17L17 17L17 13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 15L15 15.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 13L13 13.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 10L8 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 5L21 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 5L10 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 5L3 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 3L19 3"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 3L8 3"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	OpenAiIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7865a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
					],
				],
				[],
			],
		],
	],
	ClaudeIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
					],
				],
				[],
			],
		],
	],
	GeminiIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z",
					],
				],
				[],
			],
		],
	],
	PerplexityIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M19.785 0v7.272H22.5V17.62h-2.935V24l-7.037-6.194v6.145h-1.091v-6.152L4.392 24v-6.465H1.5V7.188h2.884V0l7.053 6.494V.19h1.09v6.49L19.786 0zm-7.257 9.044v7.319l5.946 5.234V14.44l-5.946-5.397zm-1.099-.08l-5.946 5.398v7.235l5.946-5.234V8.965zm8.136 7.58h1.844V8.349H13.46l6.105 5.54v2.655zm-8.982-8.28H2.59v8.195h1.8v-2.576l6.192-5.62zM5.475 2.476v4.71h5.115l-5.115-4.71zm13.219 0l-5.115 4.71h5.115v-4.71z",
					],
				],
				[],
			],
		],
	],
	MetaIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M6.897 4c1.915 0 3.516.932 5.43 3.376l.282-.373c.19-.246.383-.484.58-.71l.313-.35C14.588 4.788 15.792 4 17.225 4c1.273 0 2.469.557 3.491 1.516l.218.213c1.73 1.765 2.917 4.71 3.053 8.026l.011.392.002.25c0 1.501-.28 2.759-.818 3.7l-.14.23-.108.153c-.301.42-.664.758-1.086 1.009l-.265.142-.087.04a3.493 3.493 0 01-.302.118 4.117 4.117 0 01-1.33.208c-.524 0-.996-.067-1.438-.215-.614-.204-1.163-.56-1.726-1.116l-.227-.235c-.753-.812-1.534-1.976-2.493-3.586l-1.43-2.41-.544-.895-1.766 3.13-.343.592C7.597 19.156 6.227 20 4.356 20c-1.21 0-2.205-.42-2.936-1.182l-.168-.184c-.484-.573-.837-1.311-1.043-2.189l-.067-.32a8.69 8.69 0 01-.136-1.288L0 14.468c.002-.745.06-1.49.174-2.23l.1-.573c.298-1.53.828-2.958 1.536-4.157l.209-.34c1.177-1.83 2.789-3.053 4.615-3.16L6.897 4zm-.033 2.615l-.201.01c-.83.083-1.606.673-2.252 1.577l-.138.199-.01.018c-.67 1.017-1.185 2.378-1.456 3.845l-.004.022a12.591 12.591 0 00-.207 2.254l.002.188c.004.18.017.36.04.54l.043.291c.092.503.257.908.486 1.208l.117.137c.303.323.698.492 1.17.492 1.1 0 1.796-.676 3.696-3.641l2.175-3.4.454-.701-.139-.198C9.11 7.3 8.084 6.616 6.864 6.616zm10.196-.552l-.176.007c-.635.048-1.223.359-1.82.933l-.196.198c-.439.462-.887 1.064-1.367 1.807l.266.398c.18.274.362.56.55.858l.293.475 1.396 2.335.695 1.114c.583.926 1.03 1.6 1.408 2.082l.213.262c.282.326.529.54.777.673l.102.05c.227.1.457.138.718.138.176.002.35-.023.518-.073.338-.104.61-.32.813-.637l.095-.163.077-.162c.194-.459.29-1.06.29-1.785l-.006-.449c-.08-2.871-.938-5.372-2.2-6.798l-.176-.189c-.67-.683-1.444-1.074-2.27-1.074z",
					],
				],
				[],
			],
		],
	],
	ByteDanceIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M14.944 18.587l-1.704-.445V10.01l1.824-.462c1-.254 1.84-.461 1.88-.453.032 0 .056 2.235.056 4.972v4.973l-.176-.008c-.104 0-.952-.207-1.88-.446z",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M7 16.542c0-2.736.024-4.98.064-4.98.032-.008.872.2 1.88.454l1.816.461-.016 4.05-.024 4.049-1.632.422c-.896.23-1.736.445-1.856.469L7 21.523v-4.98z",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M19.24 12.477c0-9.03.008-9.515.144-9.475.072.024.784.207 1.576.406.792.207 1.576.405 1.744.445l.296.08-.016 8.56-.024 8.568-1.624.414c-.888.23-1.728.437-1.856.47l-.24.055v-9.523z",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M1 12.509c0-4.678.024-8.505.064-8.505.032 0 .872.207 1.872.454l1.824.461v7.582c0 4.16-.016 7.574-.032 7.574-.024 0-.872.215-1.88.47L1 21.013v-8.505z",
					],
				],
				[],
			],
		],
	],
	DeepSeekIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z",
					],
				],
				[],
			],
		],
	],
	GrokIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815",
					],
				],
				[],
			],
		],
	],
	MistralIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					["clip-rule", "evenodd"],
					[
						"d",
						"M3.428 3.4h3.429v3.428h3.429v3.429h-.002 3.431V6.828h3.427V3.4h3.43v13.714H24v3.429H13.714v-3.428h-3.428v-3.429h-3.43v3.428h3.43v3.429H0v-3.429h3.428V3.4zm10.286 13.715h3.428v-3.429h-3.427v3.429z",
					],
				],
				[],
			],
		],
	],
	KimiIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z",
					],
				],
				[],
			],
		],
	],
	AmazonIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M6.763 11.212c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 01-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 01-.287-.375 6.18 6.18 0 01-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.39-.384-.59-.894-.59-1.533 0-.678.24-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103-.295.072-.583.16-.862.272-.09.04-.184.075-.28.104a.488.488 0 01-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 01.224-.167 4.577 4.577 0 011.005-.36 4.84 4.84 0 011.246-.151c.95 0 1.644.216 2.091.647.44.43.662 1.085.662 1.963v2.586h.016zm-3.24 1.214c.263 0 .534-.048.822-.144a1.78 1.78 0 00.758-.51 1.27 1.27 0 00.272-.512c.047-.191.08-.423.08-.694v-.335a6.66 6.66 0 00-.735-.136 6.02 6.02 0 00-.75-.048c-.535 0-.926.104-1.19.32-.263.215-.39.518-.39.917 0 .375.095.655.295.846.191.2.47.296.838.296zm6.41.862c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.311L7.586 6.726a1.398 1.398 0 01-.072-.32c0-.128.064-.2.191-.2h.783c.151 0 .255.025.31.08.065.048.113.16.16.312l1.342 5.284 1.245-5.284c.04-.16.088-.264.151-.312a.549.549 0 01.32-.08h.638c.152 0 .256.025.32.08.063.048.12.16.151.312l1.261 5.348 1.381-5.348c.048-.16.104-.264.16-.312a.52.52 0 01.311-.08h.743c.127 0 .2.065.2.2 0 .04-.009.08-.017.128a1.137 1.137 0 01-.056.2l-1.923 6.17c-.048.16-.104.263-.168.311a.51.51 0 01-.303.08h-.687c-.15 0-.255-.024-.32-.08-.063-.056-.119-.16-.15-.32L12.32 7.747l-1.23 5.14c-.04.16-.087.264-.15.32-.065.056-.177.08-.32.08l-.686.001zm10.256.215c-.415 0-.83-.048-1.229-.143-.399-.096-.71-.2-.918-.32-.128-.071-.215-.151-.247-.223a.563.563 0 01-.048-.224v-.407c0-.167.064-.247.183-.247.048 0 .096.008.144.024.048.016.12.048.2.08.271.12.566.215.878.279.32.064.63.096.95.096.502 0 .894-.088 1.165-.264a.86.86 0 00.415-.758.777.777 0 00-.215-.559c-.144-.151-.416-.287-.807-.415l-1.157-.36c-.583-.183-1.014-.454-1.277-.813a1.902 1.902 0 01-.4-1.158c0-.335.073-.63.216-.886.144-.255.335-.479.575-.654.24-.184.51-.32.83-.415.32-.096.655-.136 1.006-.136.175 0 .36.008.535.032.183.024.35.056.518.088.16.04.312.08.455.127.144.048.256.096.336.144a.69.69 0 01.24.2.43.43 0 01.071.263v.375c0 .168-.064.256-.184.256a.83.83 0 01-.303-.096 3.652 3.652 0 00-1.532-.311c-.455 0-.815.071-1.062.223-.248.152-.375.383-.375.71 0 .224.08.416.24.567.16.152.454.304.877.44l1.134.358c.574.184.99.44 1.237.767.247.327.367.702.367 1.117 0 .343-.072.655-.207.926a2.157 2.157 0 01-.583.703c-.248.2-.543.343-.886.447-.36.111-.734.167-1.142.167z",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M.378 15.475c3.384 1.963 7.56 3.153 11.877 3.153 2.914 0 6.114-.607 9.06-1.852.44-.2.814.287.383.607-2.626 1.94-6.442 2.969-9.722 2.969-4.598 0-8.74-1.7-11.87-4.526-.247-.223-.024-.527.272-.351zm23.531-.2c.287.36-.08 2.826-1.485 4.007-.215.184-.423.088-.327-.151l.175-.439c.343-.88.802-2.198.52-2.555-.336-.43-2.22-.207-3.074-.103-.255.032-.295-.192-.063-.36 1.5-1.053 3.967-.75 4.254-.399z",
					],
				],
				[],
			],
		],
	],
	CohereIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					["clip-rule", "evenodd"],
					[
						"d",
						"M8.128 14.099c.592 0 1.77-.033 3.398-.703 1.897-.781 5.672-2.2 8.395-3.656 1.905-1.018 2.74-2.366 2.74-4.18A4.56 4.56 0 0018.1 1H7.549A6.55 6.55 0 001 7.55c0 3.617 2.745 6.549 7.128 6.549z",
					],
				],
				[],
			],
			[
				"path",
				[
					["clip-rule", "evenodd"],
					[
						"d",
						"M9.912 18.61a4.387 4.387 0 012.705-4.052l3.323-1.38c3.361-1.394 7.06 1.076 7.06 4.715a5.104 5.104 0 01-5.105 5.104l-3.597-.001a4.386 4.386 0 01-4.386-4.387z",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M4.776 14.962A3.775 3.775 0 001 18.738v.489a3.776 3.776 0 007.551 0v-.49a3.775 3.775 0 00-3.775-3.775z",
					],
				],
				[],
			],
		],
	],
	MarkdownIcon: [
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
					["d", "M3 5H21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 19H21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M23 7V17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M1 7V17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 15V9H6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 15V9H10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 9L17 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 12.99L17 13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 13H15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 14H16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"rect",
				[
					["x", "7"],
					["y", "10"],
					["width", "2"],
					["height", "2"],
					["fill", "currentColor"],
				],
				[],
			],
		],
	],
	FileCodeIcon: [
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
					["d", "M20 12L20 4"],
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
					["d", "M6 22H8"],
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
			[
				"path",
				[
					["d", "M22 19H22.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12.01 19H12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20.5 17.5H20.51"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13.51 17.5H13.5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 16H19.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15.01 16H15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20.5 20.5H20.51"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13.51 20.5H13.5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 22H19.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15.01 22H15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ArrowThroughLineRightIcon: [
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
					["d", "M20 10L20 14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 2L12 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 12L22 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 16L12 22"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 16L18.01 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 8L18.01 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	MicrosoftColorIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["aria-hidden", "true"],
			["class", "__icon_class__"],
		],
		[
			[
				"path",
				[
					["fill", "#F25022"],
					["d", "M0 0h11.377v11.377H0z"],
				],
				[],
			],
			[
				"path",
				[
					["fill", "#7FBA00"],
					["d", "M12.623 0H24v11.377H12.623z"],
				],
				[],
			],
			[
				"path",
				[
					["fill", "#00A4EF"],
					["d", "M0 12.623h11.377V24H0z"],
				],
				[],
			],
			[
				"path",
				[
					["fill", "#FFB900"],
					["d", "M12.623 12.623H24V24H12.623z"],
				],
				[],
			],
		],
	],
	ConnectionIcon: [
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
					["d", "M12 20V17"],
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
					["d", "M8 22L10 22"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 11L10 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 11L14 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 17H14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 15V11H16V15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	CopyIcon: [
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
					["d", "M19 21H9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 11V19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 11V19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 9H9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 5V7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 5V13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 3H5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"rect",
				[
					["width", "2"],
					["height", "2"],
					["transform", "matrix(-1 0 0 1 6 14)"],
					["fill", "currentColor"],
				],
				[],
			],
		],
	],
	CubeIcon: [
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
					["d", "M12 3V9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 9H21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 17L15 17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 21H19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 3H18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 19V9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 19V9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 7L20 7.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4.00001 7L4 7.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5.00001 5L5 5.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 5L19 5.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	DatabaseIcon: [
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
					["d", "M8 22H16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 16H16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 10H16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 2H16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 14H21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 20H19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 14H6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 8H21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 4H19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 20H6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 8H6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 4H6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 6V18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 6V18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 6H3.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 6H21.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	DenoIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M1.105 18.02A11.9 11.9 0 0 1 0 12.985q0-.698.078-1.376a12 12 0 0 1 .231-1.34A12 12 0 0 1 4.025 4.02a12 12 0 0 1 5.46-2.771 12 12 0 0 1 3.428-.23c1.452.112 2.825.477 4.077 1.05a12 12 0 0 1 2.78 1.774 12.02 12.02 0 0 1 4.053 7.078A12 12 0 0 1 24 12.985q0 .454-.036.914a12 12 0 0 1-.728 3.305 12 12 0 0 1-2.38 3.875c-1.33 1.357-3.02 1.962-4.43 1.936a4.4 4.4 0 0 1-2.724-1.024c-.99-.853-1.391-1.83-1.53-2.919a5 5 0 0 1 .128-1.518c.105-.38.37-1.116.76-1.437-.455-.197-1.04-.624-1.226-.829-.045-.05-.04-.13 0-.183a.155.155 0 0 1 .177-.053c.392.134.869.267 1.372.35.66.111 1.484.25 2.317.292 2.03.1 4.153-.813 4.812-2.627s.403-3.609-1.96-4.685-3.454-2.356-5.363-3.128c-1.247-.505-2.636-.205-4.06.582-3.838 2.121-7.277 8.822-5.69 15.032a.191.191 0 0 1-.315.19 12 12 0 0 1-1.25-1.634 12 12 0 0 1-.769-1.404M11.57 6.087c.649-.051 1.214.501 1.31 1.236.13.979-.228 1.99-1.41 2.013-1.01.02-1.315-.997-1.248-1.614.066-.616.574-1.575 1.35-1.635",
					],
				],
				[],
			],
		],
	],
	DiscordIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.36-.76-.54-1.09c-.01-.02-.04-.03-.07-.03c-1.5.26-2.93.71-4.27 1.33c-.01 0-.02.01-.03.02c-2.72 4.07-3.47 8.03-3.1 11.95c0 .02.01.04.03.05c1.8 1.32 3.53 2.12 5.24 2.65c.03.01.06 0 .07-.02c.4-.55.76-1.13 1.07-1.74c.02-.04 0-.08-.04-.09c-.57-.22-1.11-.48-1.64-.78c-.04-.02-.04-.08-.01-.11c.11-.08.22-.17.33-.25c.02-.02.05-.02.07-.01c3.44 1.57 7.15 1.57 10.55 0c.02-.01.05-.01.07.01c.11.09.22.17.33.26c.04.03.04.09-.01.11c-.52.31-1.07.56-1.64.78c-.04.01-.05.06-.04.09c.32.61.68 1.19 1.07 1.74c.03.01.06.02.09.01c1.72-.53 3.45-1.33 5.25-2.65c.02-.01.03-.03.03-.05c.44-4.53-.73-8.46-3.1-11.95c-.01-.01-.02-.02-.04-.02zM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12c0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12c0 1.17-.83 2.12-1.89 2.12z",
					],
				],
				[],
			],
		],
	],
	DotsIcon: [
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
					["d", "M5 12L5 12.01"],
					["stroke", "currentColor"],
					["stroke-width", "3"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 12L12 12.01"],
					["stroke", "currentColor"],
					["stroke-width", "3"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 12L19 12.01"],
					["stroke", "currentColor"],
					["stroke-width", "3"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	DotsVerticalIcon: [
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
					["d", "M12 19H12.01"],
					["stroke", "currentColor"],
					["stroke-width", "3"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 12H12.01"],
					["stroke", "currentColor"],
					["stroke-width", "3"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 5H12.01"],
					["stroke", "currentColor"],
					["stroke-width", "3"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	DownloadIcon: [
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
					["d", "M10 15H14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 21H3"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12.01 3L12.01 17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 13L8.01 13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 11L6.01 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 13L16.01 13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 11L18.01 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	EnvelopeIcon: [
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
					["d", "M12 2L12 2.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 14L12 14.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 8L20 8.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 8L4 8.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 4L14 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 4L9 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 12L9 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 12L14 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 10L17 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 6L6 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 10L6 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 6L17 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 10V19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 10V19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 21L4 21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ExternalLinkIcon: [
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
					["d", "M14 3L21 3L21 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 21L5 21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 19L3 5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 19L21 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 3L5 3"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 11L13 11.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 9L15 9.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 7L17 7.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 5L19 5.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	EyeIcon: [
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
					["d", "M13 16L11 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 14L15 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 14L9 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20.01 10L20 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 10L11 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4.01001 10L4.00001 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22.01 8L22 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18.01 8L18 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6.01001 8L6.00001 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2.01001 8L2.00001 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 6L8 6"],
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
					["d", "M6.01001 4L6.00001 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12.01 3L12 3"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 12V14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 12V14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	FaceRobotIcon: [
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
					["d", "M12 15V20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 20V17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 20V17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 15H16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 4V1"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"rect",
				[
					["x", "7"],
					["y", "8"],
					["width", "3"],
					["height", "3"],
					["fill", "currentColor"],
				],
				[],
			],
			[
				"rect",
				[
					["x", "14"],
					["y", "8"],
					["width", "3"],
					["height", "3"],
					["fill", "currentColor"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 6V18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 6V18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 4H20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 20H20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	FileIcon: [
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
	],
	FilterIcon: [
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
					["d", "M10 14V21H12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 14V19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 12L9 12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 12L15 12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 10L7 10.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 10L17 10.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 8L5 8.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 8L19 8.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 6V3H21V6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	FireIcon: [
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
					["d", "M13 2L13 2.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 4L15 4.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 6L17 6.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 8V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 18L17 18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 20H15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 18L7 18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 10V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 8L7 8.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 10L9 10.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 4V8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 12L12 12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 14V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 14V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	FloppyDiskIcon: [
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
					["d", "M7 21V15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 21V15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 13H15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 7H7V3"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 5V19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 9L21 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 3H15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 21H19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"rect",
				[
					["x", "16"],
					["y", "4"],
					["width", "2"],
					["height", "2"],
					["fill", "currentColor"],
				],
				[],
			],
			[
				"rect",
				[
					["x", "12"],
					["y", "4"],
					["width", "2"],
					["height", "2"],
					["fill", "currentColor"],
				],
				[],
			],
			[
				"rect",
				[
					["x", "18"],
					["y", "6"],
					["width", "2"],
					["height", "2"],
					["fill", "currentColor"],
				],
				[],
			],
		],
	],
	GearIcon: [
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
					["d", "M14 21H16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 21H10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 19H12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 19V17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 19V17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 15H20.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 15L11 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 15H4.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 13V11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 13L15 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 13L9 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 13V11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 9H20.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 9L11 9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 9H4.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 7V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 5H12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 7V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 3H16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 3H10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	GithubIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
					],
				],
				[],
			],
		],
	],
	GlobeIcon: [
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
	],
	GlobePointerIcon: [
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
					["d", "M21 11H3"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 19L15 15L19 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21.01 21H21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M23.01 23H23"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 17H23V19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 21V23H19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 2L15 2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 20L11 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 14V8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 11V8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7.01 4L7 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7.01 18L7 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17.01 4L17 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19.01 6L19 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5.01 6L5 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10.01 6L10 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14.01 6L14 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10.01 16L10 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12.01 4L12 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5.01 16L5 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 8V14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 8V10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	GoogleCloudIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 128 128"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					["fill", "#ea4535"],
					[
						"d",
						"M80.6 40.3h.4l-.2-.2 14-14v-.3c-11.8-10.4-28.1-14-43.2-9.5C36.5 20.8 24.9 32.8 20.7 48c.2-.1.5-.2.8-.2 5.2-3.4 11.4-5.4 17.9-5.4 2.2 0 4.3.2 6.4.6.1-.1.2-.1.3-.1 9-9.9 24.2-11.1 34.6-2.6h-.1z",
					],
				],
				[],
			],
			[
				"path",
				[
					["fill", "#557ebf"],
					[
						"d",
						"M108.1 47.8c-2.3-8.5-7.1-16.2-13.8-22.1L80 39.9c6 4.9 9.5 12.3 9.3 20v2.5c16.9 0 16.9 25.2 0 25.2H63.9v20h-.1l.1.2h25.4c14.6.1 27.5-9.3 31.8-23.1 4.3-13.8-1-28.8-13-36.9z",
					],
				],
				[],
			],
			[
				"path",
				[
					["fill", "#36a852"],
					[
						"d",
						"M39 107.9h26.3V87.7H39c-1.9 0-3.7-.4-5.4-1.1l-15.2 14.6v.2c6 4.3 13.2 6.6 20.7 6.6z",
					],
				],
				[],
			],
			[
				"path",
				[
					["fill", "#f9bc15"],
					[
						"d",
						"M40.2 41.9c-14.9.1-28.1 9.3-32.9 22.8-4.8 13.6 0 28.5 11.8 37.3l15.6-14.9c-8.6-3.7-10.6-14.5-4-20.8 6.6-6.4 17.8-4.4 21.7 3.8L68 55.2C61.4 46.9 51.1 42 40.2 42.1z",
					],
				],
				[],
			],
		],
	],
	GridIcon: [
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
					["d", "M4 4H10V10H4Z"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 4H20V10H14Z"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 14H10V20H4Z"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 14H20V20H14Z"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	GridSquareCirclePlusIcon: [
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
					["d", "M19 21L16 21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 21L5 21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 16L21 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 16L14 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 16L10 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 16L3 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 14L16 14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 14L5 14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 10L5 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17.5 8.5L17.5 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19.5 6.5L21 6.5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 6.5L15.5 6.5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 5L10 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 5L3 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17.5 3L17.5 4.5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 3L5 3"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	HazelIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 266 219"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					["fill-rule", "evenodd"],
					["clip-rule", "evenodd"],
					[
						"d",
						"M155 124.5C167.16 122 187.95 109.3 194.35 96.5H194.35C186.18 82.16 159.85 55 119.85 61C117.85 55.83 111.35 43.4 101.35 35C89.35 43 36.85 167.5 93.35 219C65.35 210.16 7.65 178.6 0.85 123C-7.64 53.5 48.85 8.5 98.85 8.5C113.44 8.5 132.42 10.75 151.99 13.08C199.45 18.73 250.35 24.78 250.35 0C270.18 29 289 137.5 172.5 183.5C172.84 182.02 173.22 180.49 173.61 178.92C177.93 161.62 183.42 139.63 155 124.5ZM146 88.5C146 93.19 142.19 97 137.5 97C132.80 97 129 93.19 129 88.5C129 83.80 132.80 80 137.5 80C142.19 80 146 83.80 146 88.5ZM120.78 136.70C92.00 138.35 87.77 156.55 89.25 165.44C89.25 169.30 95.96 172.51 102.08 175.45C107.69 178.13 112.82 180.59 111.89 183.10C109.95 188.35 100.57 188.57 96.12 188.03C99.90 198.70 111.00 219.39 125.23 216.77C139.46 214.14 150.02 196.51 153.53 188.03C149.49 188.85 137.76 186.38 137.76 181.46C137.76 179.71 140.55 178.54 144.14 177.01C150.71 174.23 160 170.31 160 159.70C159.03 139.99 136.95 135.33 126.04 135.47C128.30 127.59 134.80 124.25 137.76 123.56C136.79 118.97 132.78 117.27 130.89 117C123.45 122.58 121.05 132.46 120.78 136.70Z",
					],
				],
				[],
			],
		],
	],
	GripDotsIcon: [
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
					["d", "M9 6L9 6.01"],
					["stroke", "currentColor"],
					["stroke-width", "3"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 12L9 12.01"],
					["stroke", "currentColor"],
					["stroke-width", "3"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 18L9 18.01"],
					["stroke", "currentColor"],
					["stroke-width", "3"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 6L15 6.01"],
					["stroke", "currentColor"],
					["stroke-width", "3"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 12L15 12.01"],
					["stroke", "currentColor"],
					["stroke-width", "3"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 18L15 18.01"],
					["stroke", "currentColor"],
					["stroke-width", "3"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	HistoryIcon: [
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
					["d", "M12 12V8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 12L15 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 4H4V8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	HouseIcon: [
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
					["d", "M12 21V17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 2H13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 19L21 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 19L3 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 8.00999V7.99999"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 6.00999V5.99999"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 4.00999V3.99999"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 4.00999V3.99999"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 6.00999V5.99999"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 8.00999V7.99999"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 21H19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	IndustryIcon: [
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
					["d", "M8 21H21V12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 2H8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 14.01V14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 16.01V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 16.01V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 4.01V4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 10H8V21H3V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 12V14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 6H10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 12V14H13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 6L6 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	KafkaIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M9.71 2.136a1.43 1.43 0 0 0-2.047 0h-.007a1.48 1.48 0 0 0-.421 1.042c0 .41.161.777.422 1.039l.007.007c.257.264.616.426 1.019.426.404 0 .766-.162 1.027-.426l.003-.007c.261-.262.421-.629.421-1.039 0-.408-.159-.777-.421-1.042H9.71zM8.683 22.295c.404 0 .766-.167 1.027-.429l.003-.008c.261-.261.421-.631.421-1.036 0-.41-.159-.778-.421-1.044H9.71a1.42 1.42 0 0 0-1.027-.432 1.4 1.4 0 0 0-1.02.432h-.007c-.26.266-.422.634-.422 1.044 0 .406.161.775.422 1.036l.007.008c.258.262.617.429 1.02.429zm7.89-4.462c.359-.096.683-.33.882-.684l.027-.052a1.47 1.47 0 0 0 .114-1.067 1.454 1.454 0 0 0-.675-.896l-.021-.014a1.425 1.425 0 0 0-1.078-.132c-.36.091-.684.335-.881.686-.2.349-.241.75-.146 1.119.099.363.33.691.675.896h.002c.346.203.737.239 1.101.144zm-6.405-7.342a2.083 2.083 0 0 0-1.485-.627c-.58 0-1.103.242-1.482.627-.378.385-.612.916-.612 1.507s.233 1.124.612 1.514a2.08 2.08 0 0 0 2.967 0c.379-.39.612-.923.612-1.514s-.233-1.122-.612-1.507zm-.835-2.51c.843.141 1.6.552 2.178 1.144h.004c.092.093.182.196.265.299l1.446-.851a3.176 3.176 0 0 1-.047-1.808 3.149 3.149 0 0 1 1.456-1.926l.025-.016a3.062 3.062 0 0 1 2.345-.306c.77.21 1.465.721 1.898 1.482v.002c.431.757.518 1.626.313 2.408a3.145 3.145 0 0 1-1.456 1.928l-.198.118h-.02a3.095 3.095 0 0 1-2.154.201 3.127 3.127 0 0 1-1.514-.944l-1.444.848a4.162 4.162 0 0 1 0 2.879l1.444.846c.413-.47.939-.789 1.514-.944a3.041 3.041 0 0 1 2.371.319l.048.023v.002a3.17 3.17 0 0 1 1.408 1.906 3.215 3.215 0 0 1-.313 2.405l-.026.053-.003-.005a3.147 3.147 0 0 1-1.867 1.436 3.096 3.096 0 0 1-2.371-.318v-.006a3.156 3.156 0 0 1-1.456-1.927 3.175 3.175 0 0 1 .047-1.805l-1.446-.848a3.905 3.905 0 0 1-.265.294l-.004.005a3.938 3.938 0 0 1-2.178 1.138v1.699a3.09 3.09 0 0 1 1.56.862l.002.004c.565.572.914 1.368.914 2.243 0 .873-.35 1.664-.914 2.239l-.002.009a3.1 3.1 0 0 1-2.21.931 3.1 3.1 0 0 1-2.206-.93h-.002v-.009a3.186 3.186 0 0 1-.916-2.239c0-.875.35-1.672.916-2.243v-.004h.002a3.1 3.1 0 0 1 1.558-.862v-1.699a3.926 3.926 0 0 1-2.176-1.138l-.006-.005a4.098 4.098 0 0 1-1.173-2.874c0-1.122.452-2.136 1.173-2.872h.006a3.947 3.947 0 0 1 2.176-1.144V6.289a3.137 3.137 0 0 1-1.558-.864h-.002v-.004a3.192 3.192 0 0 1-.916-2.243c0-.871.35-1.669.916-2.243l.002-.002A3.084 3.084 0 0 1 8.683 0c.861 0 1.641.355 2.21.932v.002h.002c.565.574.914 1.372.914 2.243 0 .876-.35 1.667-.914 2.243l-.002.005a3.142 3.142 0 0 1-1.56.864v1.692zm8.121-1.129l-.012-.019a1.452 1.452 0 0 0-.87-.668 1.43 1.43 0 0 0-1.103.146h.002c-.347.2-.58.529-.677.896-.095.365-.054.768.146 1.119l.007.009c.2.347.519.579.874.673.357.103.755.059 1.098-.144l.019-.009a1.47 1.47 0 0 0 .657-.885 1.493 1.493 0 0 0-.141-1.118",
					],
				],
				[],
			],
		],
	],
	KeyboardIcon: [
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
					["d", "M14 14L10 14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 10H6.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 14H6.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 10H10.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 10H14.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 10H18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 14H18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 6H20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 18H20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 8V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 8V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	KubernetesIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "#326CE5"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M10.20 14.35l.007.01-.999 2.41a5.17 5.17 0 0 1-2.07-2.59l2.57-.437.00.005a.44.44 0 0 1 .484.60zm-.833-2.12a.44.44 0 0 0 .173-.756l.002-.011L7.58 9.7a5.14 5.14 0 0 0-.73 3.25l2.51-.725.00-.009zm1.14-1.98a.44.44 0 0 0 .699-.337l.01-.005.15-2.62a5.14 5.14 0 0 0-3.01 1.44l2.14 1.52.004-.002zm.76 2.75l.723.34.722-.347.18-.78-.5-.623h-.804l-.5.62.179.77zm1.5-3.09a.44.44 0 0 0 .7.33l.008.00 2.13-1.51a5.18 5.18 0 0 0-2.99-1.44l.148 2.61.002.00zm10.87 5.97l-5.77 7.18a1.6 1.6 0 0 1-1.24.594l-9.26.003a1.6 1.6 0 0 1-1.24-.596l-5.77-7.18a1.58 1.58 0 0 1-.307-1.34L2.1 5.57c.108-.47.42-.864.86-1.07L11.30.513a1.60 1.60 0 0 1 1.38 0l8.34 3.98c.438.20.755.60.863 1.07l2.06 8.95c.108.47-.005.96-.308 1.34zm-3.28-2.05c-.042-.01-.103-.026-.145-.034-.174-.033-.315-.025-.479-.038-.35-.037-.638-.067-.895-.148-.105-.04-.18-.165-.216-.216l-.201-.059a6.45 6.45 0 0 0-.105-2.33 6.46 6.46 0 0 0-.936-2.16c.052-.047.15-.133.17-.159.00-.09.00-.183.09-.282.19-.185.44-.338.74-.522.14-.084.27-.137.41-.242.03-.024.07-.062.11-.089.24-.191.29-.52.12-.736-.172-.216-.506-.236-.745-.045-.034.02-.08.06-.111.08-.134.11-.217.23-.33.35-.246.25-.45.45-.673.60-.097.05-.239.03-.303.03l-.19.13a6.54 6.54 0 0 0-4.14-2.00l-.012-.223c-.065-.062-.143-.115-.163-.25-.022-.268.01-.557.05-.905.02-.163.06-.298.06-.475.00-.04-.001-.099-.001-.142 0-.306-.224-.555-.5-.555-.275 0-.499.24-.499.55l.001.01c0 .041-.002.09 0 .128.00.177.04.312.06.475.04.348.07.637.05.906a.545.54 0 0 1-.162.25l-.012.21a6.42 6.42 0 0 0-4.16 2.00 8.37 8.37 0 0 1-.18-.128c-.09.01-.18.04-.297-.029-.223-.15-.427-.358-.673-.608-.113-.12-.195-.234-.329-.349-.03-.026-.077-.062-.111-.088a.594.59 0 0 0-.348-.132.48.481 0 0 0-.398.17c-.172.21-.117.54.123.73l.007.00.104.08c.142.10.272.15.414.24.299.18.546.33.743.52.076.08.09.22.1.28l.16.14a6.46 6.46 0 0 0-1.02 4.50l-.208.06c-.055.07-.133.18-.215.21-.257.08-.546.11-.895.14-.164.01-.305.00-.48.03-.037.00-.09.02-.133.03l-.004.00-.007.00c-.295.07-.484.34-.423.60.061.26.349.42.645.36l.007-.001.01-.003.12-.029c.17-.046.29-.113.44-.172.33-.118.60-.217.87-.256.11-.009.23.06.288.10l.217-.037a6.5 6.5 0 0 0 2.88 3.59l-.09.21c.033.08.069.19.044.28-.097.25-.263.51-.452.81-.091.13-.185.24-.268.39-.02.03-.045.09-.064.13-.128.27-.034.59.213.71.24.12.55-.007.69-.282v-.002c.02-.039.04-.09.06-.127.07-.162.09-.301.14-.458.13-.332.20-.68.38-.897.05-.06.13-.082.21-.105l.113-.205a6.45 6.45 0 0 0 4.60.012l.106.19c.086.02.18.04.256.15.136.23.229.50.342.84.05.15.074.29.145.45.016.03.043.09.06.129.13.276.44.402.69.28.247-.118.34-.435.21-.71-.02-.039-.045-.096-.065-.134-.083-.156-.177-.261-.268-.398-.19-.296-.346-.541-.443-.793-.04-.13.00-.21.03-.294-.018-.022-.059-.144-.083-.202a6.49 6.49 0 0 0 2.88-3.62c.064.01.17.03.21.038.07-.05.14-.114.28-.104.26.039.54.13.87.25.154.06.27.128.44.173.03.01.08.019.13.02l.009.00.007.00c.297.06.584-.098.64-.365.06-.266-.128-.537-.423-.608zM16.4 9.70l-1.95 1.74v.005a.44.44 0 0 0 .173.75l.003.01 2.52.728a5.19 5.19 0 0 0-.108-1.67A5.20 5.20 0 0 0 16.4 9.7zm-4.01 5.32a.437.43 0 0 0-.404-.232.44.44 0 0 0-.372.23h-.002l-1.26 2.29a5.16 5.16 0 0 0 3.32.003l-1.27-2.29h-.01zm1.88-1.29a.44.44 0 0 0-.27.03.44.44 0 0 0-.214.57l-.003.00 1.01 2.43a5.15 5.15 0 0 0 2.08-2.61l-2.6-.44-.004.00z",
					],
				],
				[],
			],
		],
	],
	LayersIcon: [
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
					["d", "M13 3L11 3"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 5L8 5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 5L15 5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 7L5 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 7L18 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 9L2 9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 9L21 9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 11L5 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 11L18 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 13L8 13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 13L15 13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 15L2 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 15L11 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 15L21 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 17L5 17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 17L18 17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 19L8 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 19L15 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 21L11 21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	LayoutLeftIcon: [
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
					["d", "M10 20L20 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 20L6 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 6L22 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 6L8 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 6L2 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 4H20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 4L6 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	LayoutMoveToLeftIcon: [
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
					["d", "M4 20H20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 16.01L14 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 14.01L12 14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 12.01L10 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 10.01L12 9.99999"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 8.00999L14 7.99999"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 8L6 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 6L22 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 6L2 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 4H20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	LayoutMoveToRightIcon: [
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
					["d", "M4 20H20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 16L10 16.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 14L12 14.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 12L14 12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 10L12 10.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 8.00002L10 8.01002"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 8L18 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 6L22 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 6L2 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 4H20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	LayoutRightIcon: [
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
					["d", "M20 20L18 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 20L4 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 6L22 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 6L16 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 6L2 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 4L18 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 4H4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	LinkIcon: [
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
					["d", "M10 17H10.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 7L13.99 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 19H12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 5L11.99 5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 19H19.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 5L4.99 5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 10H10.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 14L13.99 14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 21H17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 3L7 3"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 14L21 17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 10L3 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 12L8 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 12L16 9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	LoaderIcon: [
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
					["d", "M12 19V22"],
					["opacity", "0.5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19.01 19L19 19"],
					["opacity", "0.63"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5.01001 19L5.00001 19"],
					["opacity", "0.38"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17.01 17L17 17"],
					["opacity", "0.63"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7.01001 17L7.00001 17"],
					["opacity", "0.38"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22.005 11.995L19.005 11.995"],
					["opacity", "0.75"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5.005 11.995L2.005 11.995"],
					["opacity", "0.25"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17.01 7L17 7"],
					["opacity", "0.88"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7.01001 7L7.00001 7"],
					["opacity", "0.13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19.01 5L19 5"],
					["opacity", "0.88"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5.01001 5L5.00001 5"],
					["opacity", "0.13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 2V5"],
					["opacity", "1"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	LockIcon: [
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
					["d", "M16 4V10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 15V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 21H19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 12V19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 12V19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 10V4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 10H19"],
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
		],
	],
	LogoutIcon: [
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
					["d", "M4 10V14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 12H1.99997"],
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
					["d", "M6 8.01001L6 8.00001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 16.01L6 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	LineHeightIcon: [
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
					["d", "M3 3H21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 21H21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 14H16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 7H12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 10V9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 10V9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 17V12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 17V12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	MagnifierIcon: [
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
					["d", "M15 19H7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 3L7 3"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 15L3 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 15L19 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 19L19 19.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 21L21 21.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 17L5 17.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 17L17 17.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 5L17 5.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 5L5 5.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	MapleMark: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 739 739"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["role", "img"],
			["aria-label", "Maple"],
		],
		[
			[
				"path",
				[
					["fill-rule", "evenodd"],
					["clip-rule", "evenodd"],
					["fill", "currentColor"],
					[
						"d",
						"M369.38 0C480.324 2.908e-08 572.686 76.542 592.669 177.775C681.438 222.749 738.763 293.878 738.765 373.942C738.763 482.538 633.316 574.71 486.96 607.449C499.978 645.591 508.455 690.397 510.789 738.765L227.967 738.764C229.399 709.074 233.146 680.725 238.834 654.436C269.538 661.732 306.949 666.785 347.396 664.859L345.194 618.741C208.102 625.268 0.005 528.243 0 373.948C2.099e-08 293.883 57.322 222.751 146.093 177.775C166.076 76.543 258.436 0.001 369.38 0ZM202.322 258.434C174.48 255.016 149.271 273.738 146.015 300.254L133.046 405.874C129.791 432.389 149.721 456.662 177.563 460.08C205.404 463.499 230.614 444.769 233.87 418.254L246.839 312.633C250.095 286.118 230.163 261.853 202.322 258.434ZM367.3 278.691C339.459 275.273 314.117 295.071 310.699 322.913L298.319 423.736C294.902 451.576 314.7 476.918 342.541 480.337C370.382 483.755 395.724 463.955 399.143 436.115L411.523 335.292C414.941 307.451 395.142 282.109 367.3 278.691Z",
					],
				],
				[],
			],
		],
	],
	MaximizeIcon: [
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
					["d", "M20 11L20 4L13 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 13L4 20L11 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 18H5.99"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 16H7.99"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 14H9.99"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 12H11.99"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 10H13.99"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 8H15.99"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 6H17.99"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	MediaPauseIcon: [
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
					["d", "M15 18L15 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 18L20 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 18L4 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 18L9 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 4H7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 4H18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 20H18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 20H7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	MenuIcon: [
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
					["d", "M3 19L21 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 12L12 12L21 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 5L21 5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	MessagesIcon: [
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
					["d", "M16.01 4L16 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20.01 13L20 13"],
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
					["d", "M13.01 13L13 13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13.01 20L13 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4.01 14L4 14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4.01 4L4 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 18L2 18L2 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 2L14 2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 11L18 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 22L22 22L22 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 15L22 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 15L11 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 6L2 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 6L18 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	MinimizeIcon: [
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
					["d", "M14 5L14.0001 9.99987L19 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10.0002 18.9999L10.0001 14L5.00024 13.9999"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 16L8 16.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 18L6 18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 20L4 20.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 8L16 8.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 6L18 6.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 4L20 4.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	MinusIcon: [
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
					["d", "M3 12L21 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	MongodbIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "#47A248"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M17.19 9.55c-1.26-5.58-4.25-7.41-4.57-8.11-.28-.394-.53-.954-.735-1.44-.036.49-.055.68-.523 1.18-.723.56-4.43 3.68-4.74 10.02-.282 5.91 4.27 9.43 4.88 9.88l.07.05A73.49 73.49 0 0111.91 24h.481c.114-1.03.284-2.05.51-3.07.41-.296.60-.463.85-.693a11.34 11.34 0 003.63-8.46c.01-.814-.103-1.66-.197-2.21zm-5.33 8.19s0-8.29.275-8.29c.213 0 .49 10.69.49 10.69-.381-.045-.765-1.76-.765-2.40z",
					],
				],
				[],
			],
		],
	],
	MoonIcon: [
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
					["d", "M13 9L13 9.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 11L15 11.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 17L21 17.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M23 15L23 15.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 1L9 1.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 3L7 3.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 19H7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 13H17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 3L11 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 10L3 13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 21L11 21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 5L5 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 19L16 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 15L5 17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	MysqlIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "#4479A1"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M16.40 5.50c-.115 0-.193.01-.274.03v.013h.014c.054.10.146.18.21.273.05.107.1.21.154.32l.014-.015c.094-.066.14-.172.14-.333-.04-.047-.046-.094-.08-.14-.04-.067-.126-.1-.18-.153zM5.77 18.69h-.927a50.85 50.85 0 00-.27-4.41h-.008l-1.41 4.41H2.45l-1.4-4.41h-.01a72.89 72.89 0 00-.195 4.41H0c.055-1.96.192-3.81.41-5.53h1.15l1.33 4.06h.008l1.34-4.06h1.09c.242 2.01.384 3.86.42 5.53zm4.01-4.08c-.378 2.04-.876 3.53-1.49 4.46-.482.71-1.01 1.07-1.58 1.07-.153 0-.34-.046-.566-.138v-.494c.11.01.24.02.386.02.268 0 .483-.075.64-.222.19-.18.29-.382.29-.605 0-.155-.077-.47-.23-.944L6.23 14.61h.91l.727 2.36c.164.53.233.91.20 1.12.4-1.06.678-2.22.835-3.48zm12.32 4.08h-2.63v-5.53h.885v4.85h1.74zm-3.32.13l-1.01-.5c.09-.076.17-.158.25-.25.43-.506.64-1.25.648-2.25 0-1.83-.718-2.74-2.15-2.74-.704 0-1.25.232-1.65.69-.43.50-.646 1.25-.646 2.24 0 .972.19 1.68.574 2.14.35.41.87.615 1.58.615.26 0 .506-.033.72-.098l1.32.772.36-.622zM15.5 17.58c-.225-.36-.337-.94-.337-1.73 0-1.39.424-2.09 1.27-2.09.44 0 .77.16.977.5.22.362.33.936.33 1.72 0 1.40-.424 2.10-1.27 2.10-.445 0-.77-.167-.978-.5zm-1.65-.425c0 .47-.172.85-.516 1.15-.344.3-.803.45-1.38.45-.543 0-1.06-.172-1.57-.515l.237-.476c.438.22.83.328 1.19.32.332 0 .593-.073.78-.22a.754.75 0 00.3-.615c0-.33-.23-.61-.648-.845-.388-.213-1.16-.657-1.16-.657-.422-.307-.632-.636-.632-1.17 0-.45.15-.81.47-1.08.315-.278.72-.415 1.22-.415.51 0 .98.13 1.4.41l-.213.47a2.72 2.72 0 00-1.06-.23c-.283 0-.502.06-.654.20a.685.68 0 00-.248.52c0 .328.23.61.66.85.39.215 1.18.67 1.18.67.43.305.64.63.64 1.16zm9.38-5.85c-.535-.014-.95.04-1.29.188-.1.04-.26.04-.274.16.055.05.063.14.11.21.08.13.218.31.346.40.14.11.28.21.427.31.26.16.55.255.81.41.145.09.293.21.44.31.073.05.12.14.21.172v-.02c-.046-.06-.06-.147-.105-.214-.067-.067-.134-.127-.2-.193a3.22 3.22 0 00-.695-.675c-.214-.146-.682-.35-.77-.595l-.013-.014c.146-.013.32-.066.46-.106.22-.06.43-.047.67-.106.10-.027.21-.06.32-.094v-.06c-.12-.12-.21-.283-.334-.395a8.86 8.86 0 00-1.10-.823c-.21-.134-.476-.22-.697-.334-.08-.04-.214-.06-.26-.127-.12-.146-.19-.34-.275-.514a17.69 17.69 0 01-.547-1.16c-.12-.262-.193-.523-.34-.763-.69-1.13-1.43-1.82-2.58-2.5-.247-.14-.543-.2-.856-.274-.167-.008-.334-.02-.5-.027-.11-.047-.216-.174-.31-.235-.38-.24-1.36-.76-1.64-.072-.18.43.267.86.422 1.08.115.15.26.32.34.5.04.116.06.23.107.35.106.29.207.62.347.89.073.14.15.287.24.413.05.073.14.107.16.227-.094.13-.1.33-.154.5-.24.75-.146 1.69.194 2.25.10.166.36.534.70.393.3-.12.23-.5.32-.835.02-.08.00-.133.04-.187v.015c.094.18.188.36.274.55.206.32.566.66.867.89.16.12.28.328.48.402v-.02h-.015c-.043-.058-.1-.086-.154-.133a3.44 3.44 0 01-.35-.4 8.76 8.76 0 01-.747-1.21c-.11-.21-.202-.436-.29-.643-.04-.08-.04-.2-.107-.24-.1.14-.247.27-.32.45-.127.28-.14.64-.188 1.01-.027.00-.014 0-.027.01-.214-.052-.287-.274-.367-.46-.2-.475-.233-1.23-.06-1.78.047-.14.24-.582.16-.716-.042-.127-.174-.2-.247-.303a2.47 2.47 0 01-.24-.427c-.16-.374-.24-.788-.414-1.16-.08-.173-.22-.354-.334-.513-.127-.18-.267-.307-.368-.52-.033-.073-.08-.194-.027-.274.01-.054.04-.075.09-.09.08-.072.33.022.42.062.24.1.45.194.66.334.09.066.19.193.31.226h.14c.214.04.455.01.655.07.355.11.675.28.96.46a5.95 5.95 0 012.08 2.28c.08.15.115.29.188.45.14.33.31.663.45.982.14.31.275.63.476.89.1.14.50.213.68.286.13.06.34.11.46.18.23.14.45.3.67.45.11.07.443.24.463.37z",
					],
				],
				[],
			],
		],
	],
	NatsIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "#27AAE1"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M12.004 0H.404v18.807h9.938l1.714 1.602v-.026L15.966 24v-5.193h7.63V0H12.003zm7.578 14.45H15.38L6.898 6.519v7.93H4.116V4.376h4.349l8.344 7.784V4.375h2.773V14.45z",
					],
				],
				[],
			],
		],
	],
	NetworkNodesIcon: [
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
	],
	NodejsIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "#5FA04E"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M11.998,24c-0.321,0-0.641-0.084-0.922-0.247l-2.936-1.737c-0.438-0.245-0.224-0.332-0.08-0.383 c0.585-0.203,0.703-0.25,1.328-0.604c0.065-0.037,0.151-0.023,0.218,0.017l2.256,1.339c0.082,0.045,0.197,0.045,0.272,0l8.795-5.076 c0.082-0.047,0.134-0.141,0.134-0.238V6.921c0-0.099-0.053-0.192-0.137-0.242l-8.791-5.072c-0.081-0.047-0.189-0.047-0.271,0 L3.075,6.68C2.99,6.729,2.936,6.825,2.936,6.921v10.15c0,0.097,0.054,0.189,0.139,0.235l2.409,1.392 c1.307,0.654,2.108-0.116,2.108-0.89V7.787c0-0.142,0.114-0.253,0.256-0.253h1.115c0.139,0,0.255,0.112,0.255,0.253v10.021 c0,1.745-0.95,2.745-2.604,2.745c-0.508,0-0.909,0-2.026-0.551L2.28,18.675c-0.57-0.329-0.922-0.945-0.922-1.604V6.921 c0-0.659,0.353-1.275,0.922-1.603l8.795-5.082c0.557-0.315,1.296-0.315,1.848,0l8.794,5.082c0.57,0.329,0.924,0.944,0.924,1.603 v10.15c0,0.659-0.354,1.273-0.924,1.604l-8.794,5.078C12.643,23.916,12.324,24,11.998,24z M19.099,13.993 c0-1.9-1.284-2.406-3.987-2.763c-2.731-0.361-3.009-0.548-3.009-1.187c0-0.528,0.235-1.233,2.258-1.233 c1.807,0,2.473,0.389,2.747,1.607c0.024,0.115,0.129,0.199,0.247,0.199h1.141c0.071,0,0.138-0.031,0.186-0.081 c0.048-0.054,0.074-0.123,0.067-0.196c-0.177-2.098-1.571-3.076-4.388-3.076c-2.508,0-4.004,1.058-4.004,2.833 c0,1.925,1.488,2.457,3.895,2.695c2.88,0.282,3.103,0.703,3.103,1.269c0,0.983-0.789,1.402-2.642,1.402 c-2.327,0-2.839-0.584-3.011-1.742c-0.02-0.124-0.126-0.215-0.253-0.215h-1.137c-0.141,0-0.254,0.112-0.254,0.253 c0,1.482,0.806,3.248,4.655,3.248C17.501,17.007,19.099,15.91,19.099,13.993z",
					],
				],
				[],
			],
		],
	],
	NodejsMonoIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M11.998,24c-0.321,0-0.641-0.084-0.922-0.247l-2.936-1.737c-0.438-0.245-0.224-0.332-0.08-0.383 c0.585-0.203,0.703-0.25,1.328-0.604c0.065-0.037,0.151-0.023,0.218,0.017l2.256,1.339c0.082,0.045,0.197,0.045,0.272,0l8.795-5.076 c0.082-0.047,0.134-0.141,0.134-0.238V6.921c0-0.099-0.053-0.192-0.137-0.242l-8.791-5.072c-0.081-0.047-0.189-0.047-0.271,0 L3.075,6.68C2.99,6.729,2.936,6.825,2.936,6.921v10.15c0,0.097,0.054,0.189,0.139,0.235l2.409,1.392 c1.307,0.654,2.108-0.116,2.108-0.89V7.787c0-0.142,0.114-0.253,0.256-0.253h1.115c0.139,0,0.255,0.112,0.255,0.253v10.021 c0,1.745-0.95,2.745-2.604,2.745c-0.508,0-0.909,0-2.026-0.551L2.28,18.675c-0.57-0.329-0.922-0.945-0.922-1.604V6.921 c0-0.659,0.353-1.275,0.922-1.603l8.795-5.082c0.557-0.315,1.296-0.315,1.848,0l8.794,5.082c0.57,0.329,0.924,0.944,0.924,1.603 v10.15c0,0.659-0.354,1.273-0.924,1.604l-8.794,5.078C12.643,23.916,12.324,24,11.998,24z M19.099,13.993 c0-1.9-1.284-2.406-3.987-2.763c-2.731-0.361-3.009-0.548-3.009-1.187c0-0.528,0.235-1.233,2.258-1.233 c1.807,0,2.473,0.389,2.747,1.607c0.024,0.115,0.129,0.199,0.247,0.199h1.141c0.071,0,0.138-0.031,0.186-0.081 c0.048-0.054,0.074-0.123,0.067-0.196c-0.177-2.098-1.571-3.076-4.388-3.076c-2.508,0-4.004,1.058-4.004,2.833 c0,1.925,1.488,2.457,3.895,2.695c2.88,0.282,3.103,0.703,3.103,1.269c0,0.983-0.789,1.402-2.642,1.402 c-2.327,0-2.839-0.584-3.011-1.742c-0.02-0.124-0.126-0.215-0.253-0.215h-1.137c-0.141,0-0.254,0.112-0.254,0.253 c0,1.482,0.806,3.248,4.655,3.248C17.501,17.007,19.099,15.91,19.099,13.993z",
					],
				],
				[],
			],
		],
	],
	OpenjdkIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "#437291"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M11.915 0 11.7.215C9.515 2.4 7.47 6.39 6.046 10.483c-1.064 1.024-3.633 2.81-3.711 3.551-.093.87 1.746 2.611 1.55 3.235-.198.625-1.304 1.408-1.014 1.939.1.188.823.011 1.277-.491a13.389 13.389 0 0 0-.017 2.14c.076.906.27 1.668.643 2.232.372.563.956.911 1.667.911.397 0 .727-.114 1.024-.264.298-.149.571-.33.91-.5.68-.34 1.634-.666 3.53-.604 1.903.062 2.872.39 3.559.704.687.314 1.15.664 1.925.664.767 0 1.395-.336 1.807-.9.412-.563.631-1.33.72-2.24.06-.623.055-1.32 0-2.066.454.45 1.117.604 1.213.424.29-.53-.816-1.314-1.013-1.937-.198-.624 1.642-2.366 1.549-3.236-.08-.748-2.707-2.568-3.748-3.586C16.428 6.374 14.308 2.394 12.13.215zm.175 6.038a2.95 2.95 0 0 1 2.943 2.942 2.95 2.95 0 0 1-2.943 2.943A2.95 2.95 0 0 1 9.148 8.98a2.95 2.95 0 0 1 2.942-2.942zM8.685 7.983a3.515 3.515 0 0 0-.145.997c0 1.951 1.6 3.55 3.55 3.55 1.95 0 3.55-1.598 3.55-3.55 0-.329-.046-.648-.132-.951.334.095.64.208.915.336a42.699 42.699 0 0 1 2.042 5.829c.678 2.545 1.01 4.92.846 6.607-.082.844-.29 1.51-.606 1.94-.315.431-.713.651-1.315.651-.593 0-.932-.27-1.673-.61-.741-.338-1.825-.694-3.792-.758-1.974-.064-3.073.293-3.821.669-.375.188-.659.373-.911.5s-.466.2-.752.2c-.53 0-.876-.209-1.16-.64-.285-.43-.474-1.101-.545-1.948-.141-1.693.176-4.069.823-6.614a43.155 43.155 0 0 1 1.934-5.783c.348-.167.749-.31 1.192-.425zm-3.382 4.362a.216.216 0 0 1 .13.031c-.166.56-.323 1.116-.463 1.665a33.849 33.849 0 0 0-.547 2.555 3.9 3.9 0 0 0-.2-.39c-.58-1.012-.914-1.642-1.16-2.08.315-.24 1.679-1.755 2.24-1.781zm13.394.01c.562.027 1.926 1.543 2.24 1.783-.246.438-.58 1.068-1.16 2.08a4.428 4.428 0 0 0-.163.309 32.354 32.354 0 0 0-.562-2.49 40.579 40.579 0 0 0-.482-1.652.216.216 0 0 1 .127-.03z",
					],
				],
				[],
			],
		],
	],
	OpenjdkMonoIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M11.915 0 11.7.215C9.515 2.4 7.47 6.39 6.046 10.483c-1.064 1.024-3.633 2.81-3.711 3.551-.093.87 1.746 2.611 1.55 3.235-.198.625-1.304 1.408-1.014 1.939.1.188.823.011 1.277-.491a13.389 13.389 0 0 0-.017 2.14c.076.906.27 1.668.643 2.232.372.563.956.911 1.667.911.397 0 .727-.114 1.024-.264.298-.149.571-.33.91-.5.68-.34 1.634-.666 3.53-.604 1.903.062 2.872.39 3.559.704.687.314 1.15.664 1.925.664.767 0 1.395-.336 1.807-.9.412-.563.631-1.33.72-2.24.06-.623.055-1.32 0-2.066.454.45 1.117.604 1.213.424.29-.53-.816-1.314-1.013-1.937-.198-.624 1.642-2.366 1.549-3.236-.08-.748-2.707-2.568-3.748-3.586C16.428 6.374 14.308 2.394 12.13.215zm.175 6.038a2.95 2.95 0 0 1 2.943 2.942 2.95 2.95 0 0 1-2.943 2.943A2.95 2.95 0 0 1 9.148 8.98a2.95 2.95 0 0 1 2.942-2.942zM8.685 7.983a3.515 3.515 0 0 0-.145.997c0 1.951 1.6 3.55 3.55 3.55 1.95 0 3.55-1.598 3.55-3.55 0-.329-.046-.648-.132-.951.334.095.64.208.915.336a42.699 42.699 0 0 1 2.042 5.829c.678 2.545 1.01 4.92.846 6.607-.082.844-.29 1.51-.606 1.94-.315.431-.713.651-1.315.651-.593 0-.932-.27-1.673-.61-.741-.338-1.825-.694-3.792-.758-1.974-.064-3.073.293-3.821.669-.375.188-.659.373-.911.5s-.466.2-.752.2c-.53 0-.876-.209-1.16-.64-.285-.43-.474-1.101-.545-1.948-.141-1.693.176-4.069.823-6.614a43.155 43.155 0 0 1 1.934-5.783c.348-.167.749-.31 1.192-.425zm-3.382 4.362a.216.216 0 0 1 .13.031c-.166.56-.323 1.116-.463 1.665a33.849 33.849 0 0 0-.547 2.555 3.9 3.9 0 0 0-.2-.39c-.58-1.012-.914-1.642-1.16-2.08.315-.24 1.679-1.755 2.24-1.781zm13.394.01c.562.027 1.926 1.543 2.24 1.783-.246.438-.58 1.068-1.16 2.08a4.428 4.428 0 0 0-.163.309 32.354 32.354 0 0 0-.562-2.49 40.579 40.579 0 0 0-.482-1.652.216.216 0 0 1 .127-.03z",
					],
				],
				[],
			],
		],
	],
	PaletteIcon: [
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
					["d", "M12 3L6 5L3 10L4 15L8 18L11 17L12 20L17 19L21 13L20 6L12 3Z"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 9L8 9.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 7L13 7.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 11L17 11.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 15L14 15.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	PaperPlaneIcon: [
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
					["d", "M18 3L21 3L21 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 8L19 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 5L13 5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 7L8 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 13L5 13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 9L3 9L3 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 13L17 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 15L11 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 18L15 21H13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	PencilIcon: [
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
	],
	PixelTriangleWarningIcon: [
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
					["d", "M4 21H20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 17L22 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 17H12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 17L2 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 13L20 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 13L4 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 9L18 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 13V9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 9L6 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 5L16 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 5L8 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 3H14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	PlanetScaleIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M0 12C0 5.373 5.373 0 12 0c4.873 0 9.067 2.904 10.947 7.077l-15.87 15.87a11.981 11.981 0 0 1-1.935-1.099L14.99 12H12l-8.485 8.485A11.962 11.962 0 0 1 0 12Zm12.004 12L24 12.004C23.998 18.628 18.628 23.998 12.004 24Z",
					],
				],
				[],
			],
		],
	],
	PlayRotateClockwiseIcon: [
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
	],
	PlusIcon: [
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
					["d", "M3 12H10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 12H21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 14V21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 3V10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	PostgresIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "#4169E1"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M23.55 14.72a.5269.52 0 0 0-.0563-.1191c-.139-.2632-.4768-.3418-1.00-.2321-1.65.3411-2.29.1312-2.52-.0191 1.34-2.04 2.44-4.52 3.04-6.82.2714-1.05.7982-3.52.1222-4.73a1.56 1.56 0 0 0-.1509-.235C21.69.9086 19.80.0248 17.50.0005c-1.49-.0158-2.77.3461-3.11.4794a9.44 9.44 0 0 0-.5159-.0816 8.04 8.04 0 0 0-1.31-.1278c-1.18-.0184-2.20.2642-3.04.8406-.8573-.3211-4.78-1.64-7.22.0788C.9359 2.15.3086 3.87.4302 6.30c.0409.81.5069 3.33 1.24 5.74.4598 1.50.9387 2.70 1.43 3.58.553.99 1.12 1.59 1.71 1.78.4474.14 1.13.1441 1.85-.7279.80-.9635 1.59-1.82 1.94-2.20.4351.23.9064.36 1.39.37a.0569.05 0 0 0 .0004.00 11.03 11.03 0 0 0-.2472.30c-.3389.43-.4094.51-1.50.7443-.3102.06-1.13.2339-1.14.8115-.0025.12.0329.23.0919.32.2269.42.9216.60 1.01.6331 1.33.3335 2.50.092 3.37-.6787-.017 2.23.0775 4.41.3454 5.08.2212.55.7618 1.90 2.46 1.90.2505 0 .5263-.0291.82-.0941 1.78-.3821 2.55-1.16 2.85-2.90.1503-.8707.40-2.87.5388-4.10.0169-.0703.03-.1207.05-.1362.00-.0005.06-.0471.42.0307a.3673.36 0 0 0 .0443.00l.2539.02.0149.00c.8468.03 1.91-.1426 2.53-.4308.64-.2988 1.80-1.03 1.59-1.66zM2.37 11.87c-.7435-2.43-1.17-4.88-1.21-5.57-.1086-2.17.4171-3.68 1.56-4.49 1.83-1.29 4.83-.5408 6.10-.13-.0032.00-.0066.00-.0098.00-2.02 2.04-1.97 5.53-1.97 5.74-.0002.08.0066.19.0162.35.0348.58.0996 1.68-.0735 2.91-.1609 1.15.1937 2.27.9728 3.08.0806.08.1648.16.2518.23-.3468.37-1.10 1.19-1.90 2.15-.5677.68-.9597.55-1.08.5087-.3919-.1307-.813-.5871-1.23-1.32-.4796-.839-.9635-2.03-1.41-3.51zm6.00 5.08c-.1711-.0428-.3271-.1132-.4322-.1772.08-.0394.23-.0902.48-.1409 1.28-.2641 1.48-.4506 1.91-1.00.0992-.126.21-.2687.36-.4426a.3549.35 0 0 0 .0737-.1298c.1708-.1513.27-.1099.43-.0417.15.0646.30.26.36.4752.02.1016.06.2945-.0452.44-.9043 1.26-2.22 1.24-3.16 1.01zm2.09-3.98-.0525.14c-.133.35-.2567.68-.3334 1.00-.6674-.0021-1.31-.2872-1.81-.8024-.6279-.6551-.9131-1.56-.7825-2.50.1828-1.30.1153-2.44.079-3.05-.005-.0857-.0095-.1607-.0122-.2199.29-.2621 1.66-.9962 2.64-.7724.44.1022.71.4057.83.928.58 2.70.0774 3.83-.3302 4.73-.084.18-.1633.36-.2311.54zm7.36 4.57c-.0169.17-.0358.37-.0618.59l-.146.43a.3547.35 0 0 0-.0182.10c-.0059.47-.054.64-.115.86-.0634.22-.1353.48-.1794 1.05-.11 1.41-.8782 2.22-2.41 2.55-1.51.3251-1.78-.4968-2.02-1.22a6.58 6.58 0 0 0-.0769-.2266c-.2154-.5858-.1911-1.41-.1574-2.55.0165-.5612-.0249-1.90-.3302-2.64.0044-.2932.01-.5909.01-.8918a.3529.35 0 0 0-.0153-.1126 1.49 1.49 0 0 0-.0439-.208c-.1226-.4283-.4213-.7866-.7797-.9351-.1424-.059-.4038-.1672-.7178-.0869.06-.276.18-.5875.30-.9249l.0529-.142c.0595-.16.13-.3257.21-.5012.42-.9476 1.01-2.24.3766-5.17-.2374-1.09-1.03-1.63-2.23-1.50-.7207.07-1.37.3654-1.70.5321a5.67 5.67 0 0 0-.1958.10c.0918-1.10.4386-3.17 1.73-4.48a4.03 4.03 0 0 1 .3033-.276.35.3532 0 0 0 .1447-.0644c.7524-.5706 1.69-.8506 2.80-.8325.40.0067.80.0339 1.17.081 1.93.3544 3.24 1.44 4.03 2.38.8143.96 1.25 1.93 1.43 2.45-1.32-.1346-2.22.1268-2.67.779-.9926 1.41.543 4.17 1.28 5.49.1353.24.2522.45.2889.54.2403.58.5515.97.7787 1.25.0696.08.1372.17.1885.24-.4008.11-1.12.3825-1.05 1.71-.0123.15-.0423.44-.0834.81-.0461.20-.0702.46-.0994.76zm.8905-1.62c-.0405-.8316.26-.9185.59-1.01a2.85 2.85 0 0 0 .135-.0406 1.20 1.20 0 0 0 .1342.10c.5703.37 1.58.4213 3.00.1344-.2016.17-.5189.39-.9533.60-.4098.19-1.09.333-1.74.3636-.7197.03-1.08-.0807-1.17-.151zm.5695-9.27c-.0059.35-.0542.66-.1054 1.00-.055.35-.112.72-.1264 1.17-.0142.43.0404.89.0932 1.33.1066.88.216 1.80-.2075 2.70a3.52 3.52 0 0 1-.1876-.3856c-.0527-.1276-.1669-.3326-.3251-.6162-.6156-1.10-2.05-3.68-1.31-4.74.3795-.5427 1.34-.5661 2.17-.463zm.2284 7.01a12.37 12.37 0 0 0-.0853-.1074l-.0355-.0444c.7262-1.19.5842-2.38.4578-3.43-.0519-.4318-.1009-.8396-.0885-1.22.0129-.4061.06-.7543.11-1.09.0639-.415.12-.8443.11-1.35.0134-.0531.01-.1158.01-.1902-.0457-.4855-.5999-1.93-1.72-3.25-.6076-.7073-1.48-1.49-2.68-2.03.5251-.1066 1.23-.2035 2.02-.1859 2.05.0456 3.67.8135 4.82 2.28a.908.90 0 0 1 .0667.10c.7231 1.35-.2762 6.27-2.98 10.54zm-8.81-6.11c-.025.17-.3089.42-.6211.42a.5821.58 0 0 1-.0809-.0056c-.1873-.026-.3765-.144-.5059-.3156-.0458-.0605-.1203-.178-.1055-.2844.00-.0401.02-.0985.09-.1488.11-.0894.35-.1226.60-.0867.31.0441.64.1938.61.4186zm7.93-.4114c.0111.07-.049.20-.1531.31-.0683.07-.212.19-.4079.22a.5456.54 0 0 1-.075.00c-.2935 0-.5414-.2344-.5607-.3717-.024-.1765.26-.3106.56-.352.29-.0414.61.0088.63.1851z",
					],
				],
				[],
			],
		],
	],
	PulseIcon: [
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
					["d", "M6 18.01L6 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 7.01001L18 7.00001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 20.01L8 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 16L4 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 9L16 9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 5L22 5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 16L10 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 11L12 14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	PuzzlePieceIcon: [
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
					["d", "M6 21H9V20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 4H9V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 18H13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 7H13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 21H15V20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 4H15V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 19L4 16L3 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 19L20 16L21 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M1 14L1 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M23 14L23 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 6L4 9L3 9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 6L20 9L21 9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	PythonIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M14.25.18l.9.2.73.26.59.3.45.32.34.34.25.34.16.33.1.3.04.26.02.2-.01.13V8.5l-.05.63-.13.55-.21.46-.26.38-.3.31-.33.25-.35.19-.35.14-.33.1-.3.07-.26.04-.21.02H8.77l-.69.05-.59.14-.5.22-.41.27-.33.32-.27.35-.2.36-.15.37-.1.35-.07.32-.04.27-.02.21v3.06H3.17l-.21-.03-.28-.07-.32-.12-.35-.18-.36-.26-.36-.36-.35-.46-.32-.59-.28-.73-.21-.88-.14-1.05-.05-1.23.06-1.22.16-1.04.24-.87.32-.71.36-.57.4-.44.42-.33.42-.24.4-.16.36-.1.32-.05.24-.01h.16l.06.01h8.16v-.83H6.18l-.01-2.75-.02-.37.05-.34.11-.31.17-.28.25-.26.31-.23.38-.2.44-.18.51-.15.58-.12.64-.1.71-.06.77-.04.84-.02 1.27.05zm-6.3 1.98l-.23.33-.08.41.08.41.23.34.33.22.41.09.41-.09.33-.22.23-.34.08-.41-.08-.41-.23-.33-.33-.22-.41-.09-.41.09zm13.09 3.95l.28.06.32.12.35.18.36.27.36.35.35.47.32.59.28.73.21.88.14 1.04.05 1.23-.06 1.23-.16 1.04-.24.86-.32.71-.36.57-.4.45-.42.33-.42.24-.4.16-.36.09-.32.05-.24.02-.16-.01h-8.22v.82h5.84l.01 2.76.02.36-.05.34-.11.31-.17.29-.25.25-.31.24-.38.2-.44.17-.51.15-.58.13-.64.09-.71.07-.77.04-.84.01-1.27-.04-1.07-.14-.9-.2-.73-.25-.59-.3-.45-.33-.34-.34-.25-.34-.16-.33-.1-.3-.04-.25-.02-.2.01-.13v-5.34l.05-.64.13-.54.21-.46.26-.38.3-.32.33-.24.35-.2.35-.14.33-.1.3-.06.26-.04.21-.02.13-.01h5.84l.69-.05.59-.14.5-.21.41-.28.33-.32.27-.35.2-.36.15-.36.1-.35.07-.32.04-.28.02-.21V6.07h2.09l.14.01zm-6.47 14.25l-.23.33-.08.41.08.41.23.33.33.23.41.08.41-.08.33-.23.23-.33.08-.41-.08-.41-.23-.33-.33-.23-.41-.08-.41.08z",
					],
				],
				[],
			],
		],
	],
	RabbitmqIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "#FF6600"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M23.035 9.601h-7.677a.956.956 0 01-.962-.962V.962a.956.956 0 00-.962-.956H10.56a.956.956 0 00-.962.956V8.64a.956.956 0 01-.962.962H5.762a.956.956 0 01-.961-.962V.962A.956.956 0 003.839 0H.959a.956.956 0 00-.956.962v22.076A.956.956 0 00.965 24h22.07a.956.956 0 00.962-.962V10.58a.956.956 0 00-.962-.98zm-3.86 8.152a1.437 1.437 0 01-1.437 1.443h-1.924a1.437 1.437 0 01-1.436-1.443v-1.917a1.437 1.437 0 011.436-1.443h1.924a1.437 1.437 0 011.437 1.443z",
					],
				],
				[],
			],
		],
	],
	RailwayIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M.113 10.27A13.026 13.026 0 000 11.48h18.23c-.064-.125-.15-.237-.235-.347-3.117-4.027-4.793-3.677-7.19-3.78-.8-.034-1.34-.048-4.524-.048-1.704 0-3.555.005-5.358.01-.234.63-.459 1.24-.567 1.737h9.342v1.216H.113v.002zm18.26 2.426H.009c.02.326.05.645.094.961h16.955c.754 0 1.179-.429 1.315-.96zm-17.318 4.28s2.81 6.902 10.93 7.024c4.855 0 9.027-2.883 10.92-7.024H1.056zM11.988 0C7.5 0 3.593 2.466 1.531 6.108l4.75-.005v-.002c3.71 0 3.849.016 4.573.047l.448.016c1.563.052 3.485.22 4.996 1.364.82.621 2.007 1.99 2.712 2.965.654.902.842 1.94.396 2.934-.408.914-1.289 1.458-2.353 1.458H.391s.099.42.249.886h22.748A12.026 12.026 0 0024 12.005C24 5.377 18.621 0 11.988 0z",
					],
				],
				[],
			],
		],
	],
	RedisIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "#FF4438"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M22.71 13.14c-1.66 2.09-3.45 4.48-7.03 4.48-3.20 0-4.39-2.82-4.48-5.12.70 1.48 2.07 2.68 4.21 2.63 4.11-.133 6.94-3.85 6.94-7.23 0-4.05-3.02-6.97-8.26-6.97-3.75 0-8.4 1.42-11.45 3.68C2.59 6.93 3.88 9.95 4.35 9.62c2.64-1.90 4.74-3.13 6.78-3.74C8.12 9.24.886 17.05 0 18.42c.1 1.26 1.66 4.64 2.42 4.64.232 0 .431-.133.66-.365a100.49 100.49 0 0 0 5.54-6.76c.222 3.10 1.74 6.89 6.01 6.89 3.81 0 7.60-2.75 9.33-8.96.2-.764-.73-1.36-1.26-.73zm-4.34-5.01c0 1.95-1.92 2.92-3.68 2.92-.941 0-1.66-.247-2.23-.568 1.05-1.59 2.09-3.22 3.21-4.97 1.97.334 2.71 1.43 2.71 2.61z",
					],
				],
				[],
			],
		],
	],
	RocketIcon: [
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
					["d", "M13 5H13.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 7H15.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 9H17.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 11H19.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 13H17.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 20H17.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 7H4.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 15H15.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 9H9.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 15H11.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 13H9.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 7H11.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 3H21V9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 15V18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 5L6 5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 17V22H15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 11L2 11L2 9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 16H6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 19L8 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 18V21H6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	RubyIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M20.156.083c3.033.525 3.893 2.598 3.829 4.77L24 4.822 22.635 22.71 4.89 23.926h.016C3.433 23.864.15 23.729 0 19.139l1.645-3 2.819 6.586.503 1.172 2.805-9.144-.03.007.016-.03 9.255 2.956-1.396-5.431-.99-3.9 8.82-.569-.615-.51L16.5 2.114 20.159.073l-.003.01zM0 19.089zM5.13 5.073c3.561-3.533 8.157-5.621 9.922-3.84 1.762 1.777-.105 6.105-3.673 9.636-3.563 3.532-8.103 5.734-9.864 3.957-1.766-1.777.045-6.217 3.612-9.75l.003-.003z",
					],
				],
				[],
			],
		],
	],
	RustIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M23.8346 11.7033l-1.0073-.6236a13.7268 13.7268 0 00-.0283-.2936l.8656-.8069a.3483.3483 0 00-.1154-.578l-1.1066-.414a8.4958 8.4958 0 00-.087-.2856l.6904-.9587a.3462.3462 0 00-.2257-.5446l-1.1663-.1894a9.3574 9.3574 0 00-.1407-.2622l.49-1.0761a.3437.3437 0 00-.0274-.3361.3486.3486 0 00-.3006-.154l-1.1845.0416a6.7444 6.7444 0 00-.1873-.2268l.2723-1.153a.3472.3472 0 00-.417-.4172l-1.1532.2724a14.0183 14.0183 0 00-.2278-.1873l.0415-1.1845a.3442.3442 0 00-.49-.328l-1.076.491c-.0872-.0476-.1742-.0952-.2623-.1407l-.1903-1.1673A.3483.3483 0 0016.256.955l-.9597.6905a8.4867 8.4867 0 00-.2855-.086l-.414-1.1066a.3483.3483 0 00-.5781-.1154l-.8069.8666a9.2936 9.2936 0 00-.2936-.0284L12.2946.1683a.3462.3462 0 00-.5892 0l-.6236 1.0073a13.7383 13.7383 0 00-.2936.0284L9.9803.3374a.3462.3462 0 00-.578.1154l-.4141 1.1065c-.0962.0274-.1903.0567-.2855.086L7.744.955a.3483.3483 0 00-.5447.2258L7.009 2.348a9.3574 9.3574 0 00-.2622.1407l-1.0762-.491a.3462.3462 0 00-.49.328l.0416 1.1845a7.9826 7.9826 0 00-.2278.1873L3.8413 3.425a.3472.3472 0 00-.4171.4171l.2713 1.1531c-.0628.075-.1255.1509-.1863.2268l-1.1845-.0415a.3462.3462 0 00-.328.49l.491 1.0761a9.167 9.167 0 00-.1407.2622l-1.1662.1894a.3483.3483 0 00-.2258.5446l.6904.9587a13.303 13.303 0 00-.087.2855l-1.1065.414a.3483.3483 0 00-.1155.5781l.8656.807a9.2936 9.2936 0 00-.0283.2935l-1.0073.6236a.3442.3442 0 000 .5892l1.0073.6236c.008.0982.0182.1964.0283.2936l-.8656.8079a.3462.3462 0 00.1155.578l1.1065.4141c.0273.0962.0567.1914.087.2855l-.6904.9587a.3452.3452 0 00.2268.5447l1.1662.1893c.0456.088.0922.1751.1408.2622l-.491 1.0762a.3462.3462 0 00.328.49l1.1834-.0415c.0618.0769.1235.1528.1873.2277l-.2713 1.1541a.3462.3462 0 00.4171.4161l1.153-.2713c.075.0638.151.1255.2279.1863l-.0415 1.1845a.3442.3442 0 00.49.327l1.0761-.49c.087.0486.1741.0951.2622.1407l.1903 1.1662a.3483.3483 0 00.5447.2268l.9587-.6904a9.299 9.299 0 00.2855.087l.414 1.1066a.3452.3452 0 00.5781.1154l.8079-.8656c.0972.0111.1954.0203.2936.0294l.6236 1.0073a.3472.3472 0 00.5892 0l.6236-1.0073c.0982-.0091.1964-.0183.2936-.0294l.8069.8656a.3483.3483 0 00.578-.1154l.4141-1.1066a8.4626 8.4626 0 00.2855-.087l.9587.6904a.3452.3452 0 00.5447-.2268l.1903-1.1662c.088-.0456.1751-.0931.2622-.1407l1.0762.49a.3472.3472 0 00.49-.327l-.0415-1.1845a6.7267 6.7267 0 00.2267-.1863l1.1531.2713a.3472.3472 0 00.4171-.416l-.2713-1.1542c.0628-.0749.1255-.1508.1863-.2278l1.1845.0415a.3442.3442 0 00.328-.49l-.49-1.076c.0475-.0872.0951-.1742.1407-.2623l1.1662-.1893a.3483.3483 0 00.2258-.5447l-.6904-.9587.087-.2855 1.1066-.414a.3462.3462 0 00.1154-.5781l-.8656-.8079c.0101-.0972.0202-.1954.0283-.2936l1.0073-.6236a.3442.3442 0 000-.5892zm-6.7413 8.3551a.7138.7138 0 01.2986-1.396.714.714 0 11-.2997 1.396zm-.3422-2.3142a.649.649 0 00-.7715.5l-.3573 1.6685c-1.1035.501-2.3285.7795-3.6193.7795a8.7368 8.7368 0 01-3.6951-.814l-.3574-1.6684a.648.648 0 00-.7714-.499l-1.473.3158a8.7216 8.7216 0 01-.7613-.898h7.1676c.081 0 .1356-.0141.1356-.088v-2.536c0-.074-.0536-.0881-.1356-.0881h-2.0966v-1.6077h2.2677c.2065 0 1.1065.0587 1.394 1.2088.0901.3533.2875 1.5044.4232 1.8729.1346.413.6833 1.2381 1.2685 1.2381h3.5716a.7492.7492 0 00.1296-.0131 8.7874 8.7874 0 01-.8119.9526zM6.8369 20.024a.714.714 0 11-.2997-1.396.714.714 0 01.2997 1.396zM4.1177 8.9972a.7137.7137 0 11-1.304.5791.7137.7137 0 011.304-.579zm-.8352 1.9813l1.5347-.6824a.65.65 0 00.33-.8585l-.3158-.7147h1.2432v5.6025H3.5669a8.7753 8.7753 0 01-.2834-3.348zm6.7343-.5437V8.7836h2.9601c.153 0 1.0792.1772 1.0792.8697 0 .575-.7107.7815-1.2948.7815zm10.7574 1.4862c0 .2187-.008.4363-.0243.651h-.9c-.09 0-.1265.0586-.1265.1477v.413c0 .973-.5487 1.1846-1.0296 1.2382-.4576.0517-.9648-.1913-1.0275-.4717-.2704-1.5186-.7198-1.8436-1.4305-2.4034.8817-.5599 1.799-1.386 1.799-2.4915 0-1.1936-.819-1.9458-1.3769-2.3153-.7825-.5163-1.6491-.6195-1.883-.6195H5.4682a8.7651 8.7651 0 014.907-2.7699l1.0974 1.151a.648.648 0 00.9182.0213l1.227-1.1743a8.7753 8.7753 0 016.0044 4.2762l-.8403 1.8982a.652.652 0 00.33.8585l1.6178.7188c.0283.2875.0425.577.0425.8717zm-9.3006-9.5993a.7128.7128 0 11.984 1.0316.7137.7137 0 01-.984-1.0316zm8.3389 6.71a.7107.7107 0 01.9395-.3625.7137.7137 0 11-.9405.3635z",
					],
				],
				[],
			],
		],
	],
	CsharpIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M1.194 7.543v8.913c0 1.103.588 2.122 1.544 2.674l7.718 4.456a3.086 3.086 0 0 0 3.088 0l7.718-4.456a3.087 3.087 0 0 0 1.544-2.674V7.543a3.084 3.084 0 0 0-1.544-2.673L13.544.414a3.086 3.086 0 0 0-3.088 0L2.738 4.87a3.085 3.085 0 0 0-1.544 2.673Zm5.403 2.914v3.087a.77.77 0 0 0 .772.772.773.773 0 0 0 .772-.772.773.773 0 0 1 1.317-.546.775.775 0 0 1 .226.546 2.314 2.314 0 1 1-4.631 0v-3.087c0-.615.244-1.203.679-1.637a2.312 2.312 0 0 1 3.274 0c.434.434.678 1.023.678 1.637a.769.769 0 0 1-.226.545.767.767 0 0 1-1.091 0 .77.77 0 0 1-.226-.545.77.77 0 0 0-.772-.772.771.771 0 0 0-.772.772Zm12.35 3.087a.77.77 0 0 1-.772.772h-.772v.772a.773.773 0 0 1-1.544 0v-.772h-1.544v.772a.773.773 0 0 1-1.317.546.775.775 0 0 1-.226-.546v-.772H12a.771.771 0 1 1 0-1.544h.772v-1.543H12a.77.77 0 1 1 0-1.544h.772v-.772a.773.773 0 0 1 1.317-.546.775.775 0 0 1 .226.546v.772h1.544v-.772a.773.773 0 0 1 1.544 0v.772h.772a.772.772 0 0 1 0 1.544h-.772v1.543h.772a.776.776 0 0 1 .772.772Zm-3.088-2.315h-1.544v1.543h1.544v-1.543Z",
					],
				],
				[],
			],
		],
	],
	KotlinIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[["path", [["d", "M24 24H0V0h24L12 12Z"]], []]],
	],
	LaravelIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M23.642 5.43a.364.364 0 01.014.1v5.149c0 .135-.073.26-.189.326l-4.323 2.49v4.934a.378.378 0 01-.188.326L9.93 23.949a.316.316 0 01-.066.027c-.008.002-.016.008-.024.01a.348.348 0 01-.192 0c-.011-.002-.02-.008-.03-.012-.02-.008-.042-.014-.062-.025L.533 18.755a.376.376 0 01-.189-.326V2.974c0-.033.005-.066.014-.098.003-.012.01-.02.014-.032a.369.369 0 01.023-.058c.004-.013.015-.022.023-.033l.033-.045c.012-.01.025-.018.037-.027.014-.012.027-.024.041-.034H.53L5.043.05a.375.375 0 01.375 0L9.93 2.647h.002c.015.01.027.021.04.033l.038.027c.013.014.02.03.033.045.008.011.02.021.025.033.01.02.017.038.024.058.003.011.01.021.013.032.01.031.014.064.014.098v9.652l3.76-2.164V5.527c0-.033.004-.066.013-.098.003-.01.01-.02.013-.032a.487.487 0 01.024-.059c.007-.012.018-.02.025-.033.012-.015.021-.03.033-.043.012-.012.025-.02.037-.028.014-.01.026-.023.041-.032h.001l4.513-2.598a.375.375 0 01.375 0l4.513 2.598c.016.01.027.021.042.031.012.01.025.018.036.028.013.014.022.03.034.044.008.012.019.021.024.033.011.02.018.04.024.06.006.01.012.021.015.032zm-.74 5.032V6.179l-1.578.908-2.182 1.256v4.283zm-4.51 7.75v-4.287l-2.147 1.225-6.126 3.498v4.325zM1.093 3.624v14.588l8.273 4.761v-4.325l-4.322-2.445-.002-.003H5.04c-.014-.01-.025-.021-.04-.031-.011-.01-.024-.018-.035-.027l-.001-.002c-.013-.012-.021-.025-.031-.04-.01-.011-.021-.022-.028-.036h-.002c-.008-.014-.013-.031-.02-.047-.006-.016-.014-.027-.018-.043a.49.49 0 01-.008-.057c-.002-.014-.006-.027-.006-.041V5.789l-2.18-1.257zM5.23.81L1.47 2.974l3.76 2.164 3.758-2.164zm1.956 13.505l2.182-1.256V3.624l-1.58.91-2.182 1.255v9.435zm11.581-10.95l-3.76 2.163 3.76 2.163 3.759-2.164zm-.376 4.978L16.21 7.087 14.63 6.18v4.283l2.182 1.256 1.58.908zm-8.65 9.654l5.514-3.148 2.756-1.572-3.757-2.163-4.323 2.489-3.941 2.27z",
					],
				],
				[],
			],
		],
	],
	ServerIcon: [
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
					["d", "M17 6.5V6.49"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 6.5V6.49"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 17.5V17.49"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 17.5V17.49"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 3L19 3"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 10L19 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 14L19 14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 21L19 21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 16V19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 16V19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 5V8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 5V8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ShieldIcon: [
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
					["d", "M6 3H18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8.01001 20L8.00001 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6.01001 18L6.00001 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16.01 20L16 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18.01 18L18 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 16V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 16V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 22H14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 14.01V14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 12.01V12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 10.01V10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 8.01V8"],
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
		],
	],
	SlackIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M9.04 2.5A2.04 2.04 0 0 0 7 4.54a2.04 2.04 0 0 0 2.04 2.04h2.04V4.54A2.04 2.04 0 0 0 9.04 2.5m0 5.44H3.6a2.04 2.04 0 0 0-2.04 2.04a2.04 2.04 0 0 0 2.04 2.04h5.44a2.04 2.04 0 0 0 2.04-2.04a2.04 2.04 0 0 0-2.04-2.04",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M21.5 9.98a2.04 2.04 0 0 0-2.04-2.04a2.04 2.04 0 0 0-2.04 2.04v2.04h2.04a2.04 2.04 0 0 0 2.04-2.04m-5.44 0V4.54A2.04 2.04 0 0 0 14.02 2.5a2.04 2.04 0 0 0-2.04 2.04v5.44a2.04 2.04 0 0 0 2.04 2.04a2.04 2.04 0 0 0 2.04-2.04",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M14.02 21.5a2.04 2.04 0 0 0 2.04-2.04a2.04 2.04 0 0 0-2.04-2.04h-2.04v2.04a2.04 2.04 0 0 0 2.04 2.04m0-5.44h5.44a2.04 2.04 0 0 0 2.04-2.04a2.04 2.04 0 0 0-2.04-2.04h-5.44a2.04 2.04 0 0 0-2.04 2.04a2.04 2.04 0 0 0 2.04 2.04",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M1.56 14.02a2.04 2.04 0 0 0 2.04 2.04a2.04 2.04 0 0 0 2.04-2.04v-2.04H3.6a2.04 2.04 0 0 0-2.04 2.04m5.44 0v5.44a2.04 2.04 0 0 0 2.04 2.04a2.04 2.04 0 0 0 2.04-2.04v-5.44a2.04 2.04 0 0 0-2.04-2.04a2.04 2.04 0 0 0-2.04 2.04",
					],
				],
				[],
			],
		],
	],
	SlidersIcon: [
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
					["d", "M14 20L16 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 17H22.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 17H8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 16L18 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 16L12 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 14L16 14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 10L8 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 7H16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 7H2.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 6L12 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 6L6 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 4L8 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	SquareSparkleIcon: [
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
					["d", "M19 3H5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 21H5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 19V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 19V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14.01 12H14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16.01 8H16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8.01 16H8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10.01 12H10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 8V10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 14V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	SquareTerminalIcon: [
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
					["d", "M13 16H17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 3H5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 21H5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 19V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 19V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11.01 12L11 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9.01001 14L9.00001 14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7.01001 16L7.00001 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7.01001 8L7.00001 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9.00999 10L8.99999 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	StackPerspectiveIcon: [
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
					["d", "M14 22H12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 20H8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 18H4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 17L20 17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 13L16 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 11H12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 9H8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 9L2 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 8L22 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 7H4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 6H18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 4H14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 4L8 5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 2H10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	StarFilledIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					["d", "M12 2L14.9 8.6L22 9.3L16.8 14L18.2 21L12 17.3L5.8 21L7.2 14L2 9.3L9.1 8.6L12 2Z"],
					["stroke", "currentColor"],
					["stroke-width", "1.5"],
					["stroke-linejoin", "round"],
				],
				[],
			],
		],
	],
	StarIcon: [
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
					["d", "M12 2.01001L12 2.00001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 19.01L9 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 19.01L15 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 12.01L4 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 12.01L20 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 17V21H7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 17V21H17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 17H13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 8H2V10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 8L22 8V10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 14V15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 14V15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 4V6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 4V6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	// Supabase mark (flat, brand green).
	SupabaseIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "#3FCF8E"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z",
					],
				],
				[],
			],
		],
	],
	SunIcon: [
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
					["d", "M12 21L12 23"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 20H20.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 20H4.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 18H18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 18H6.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 17L13 17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 15H15.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 15H9.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M23.005 11.995L21.005 11.995"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3.005 11.995L1.005 11.995"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 11L17 13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6.99999 11L7 13"],
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
			[
				"path",
				[
					["d", "M9 9H9.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 7.00001L13 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 6H18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 6H6.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 4H20.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 4H4.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 1L12 3"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	TextWrapIcon: [
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
					["d", "M3 5H21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 12H17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 14V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 18L7 18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 16V20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 18H17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ThumbtackIcon: [
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
					["d", "M12 22L12 17L12 17.2774"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4.01001 15L4.00001 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6.01001 13L6.00001 13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20.01 15L20 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18.01 13L18 13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 3H14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 17L18 17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 5V11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 5V11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	TagIcon: [
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
					["d", "M7.5 7.5L7.5 7.49"],
					["stroke", "currentColor"],
					["stroke-width", "3"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 20.01V20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 20.01V20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 18.01V18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 16.01V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 14.01V14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 18.01V18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 16.01V16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 11.01V11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 9.01V9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 7.01V7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 5.01V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 14V13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 22H13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 12V3H12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	TelegramIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 240 240"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["aria-hidden", "true"],
		],
		[
			[
				"defs",
				[],
				[
					[
						"linearGradient",
						[
							["id", "__icon_id__"],
							["x1", "120"],
							["y1", "0"],
							["x2", "120"],
							["y2", "238.5"],
							["gradientUnits", "userSpaceOnUse"],
						],
						[
							["stop", [["stop-color", "#2AABEE"]], []],
							[
								"stop",
								[
									["offset", "1"],
									["stop-color", "#229ED9"],
								],
								[],
							],
						],
					],
				],
			],
			[
				"circle",
				[
					["cx", "120"],
					["cy", "120"],
					["r", "120"],
					["fill", "url(#__icon_id__)"],
				],
				[],
			],
			[
				"path",
				[
					["fill", "#fff"],
					[
						"d",
						"M54.0684 118.708C89.0967 103.446 112.457 93.3849 124.148 88.5258C157.52 74.6474 164.454 72.2363 168.975 72.1565C169.97 72.1392 172.192 72.3858 173.632 73.5545C174.848 74.5414 175.183 75.8744 175.343 76.8101C175.503 77.7458 175.703 79.8774 175.544 81.5433C173.735 100.545 165.91 146.669 161.929 167.957C160.245 176.965 156.929 179.985 153.719 180.28C146.742 180.923 141.444 175.67 134.687 171.24C124.113 164.308 118.139 159.994 107.874 153.229C96.0112 145.412 103.702 141.115 110.461 134.094C112.23 132.256 142.972 104.297 143.567 101.759C143.641 101.442 143.71 100.259 143.008 99.6343C142.305 99.0098 141.268 99.2234 140.52 99.3933C139.459 99.6343 122.566 110.802 89.8402 132.897C85.0455 136.189 80.7028 137.792 76.8121 137.708C72.5224 137.616 64.2693 135.282 58.1353 133.288C50.6136 130.842 44.6357 129.549 45.1562 125.395C45.4273 123.231 48.4314 121.019 54.0684 118.708Z",
					],
				],
				[],
			],
		],
	],
	TrashIcon: [
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
					["d", "M17 22L7 22"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 10V20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 10V20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 6H3"],
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
					["d", "M8.00001 4H8.01001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 2H10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	UnorderedListIcon: [
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
					["d", "M7 21H5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 18L21 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 19L9 17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 19L3 17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 15H5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 9H5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 6L21 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 7L9 5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 7L3 5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 3L5 3"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	TruckIcon: [
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
					["d", "M16 7H12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 19V7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 19H16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 17V7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 17V15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 17H6.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 17H18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 13H20.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 21H6.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 21H18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 19H4.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 19H16.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 19H8.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 19H20.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 5H4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 11V9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	UiLayersIcon: [
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
					["d", "M12.01 22L12 22"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 20L14 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 20L8 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 18L18 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12.01 18L12 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 18L4 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22.01 16L22 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 16L14 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 16L8 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2.01 16L2 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 14L18 14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12.01 14L12 14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 14L4 14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22.01 12L22 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 12L14 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 12L8 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2.01 12L2 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 10L18 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 10L4 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22.01 8L22 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2.01 8L2 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 6L18 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 6L4 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 4L14 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 4L8 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12.01 2L12 2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	UploadIcon: [
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
					["d", "M10 5H14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 21L3 21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 17L12 3"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16.01 7L16 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18.01 9L18 9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8.01001 7L8.00001 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6.01001 9L6.00001 9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	UserIcon: [
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
					["d", "M5 16H6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 16H19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 14H16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 18V21H21V18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10.5 3H13.5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10.5 10H13.5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15.5 5L15.5 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8.5 5L8.5 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	XmarkIcon: [
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
					["d", "M20.0001 20L20 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4.00006 20L4.00006 20.0001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18.0001 18L18 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6.00006 18L6.00006 18.0001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16.0001 16L16 16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8.00006 16L8.00006 16.0001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14.0001 14L14 14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10.0001 14L10.0001 14.0001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12.0001 12L12 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14.0001 10L14.0001 10.0001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10.0001 10L10 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16.0001 8L16.0001 8.0001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8.00012 8L8.00002 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18.0001 6L18.0001 6.0001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6.00012 6L6.00002 6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20.0001 4L20.0001 4.0001"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4.00012 4L4.00002 4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	ArrowDownIcon: [
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
					["d", "M12 21H12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 19H14.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 17H16.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 15H18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 19H10.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 17H8.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 15H6.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 19L12 3"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	AspectRatioIcon: [
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
					["d", "M19 21H5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 3H5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 19L3 5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 19L21 5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 11V9"],
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
					["d", "M15 7L13 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 17L11 17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	IdBadgeIcon: [
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
					["d", "M18 15L14 15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 11L14 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 4V6H15V4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 2H13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 5H19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 5H4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 7V18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 7V18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 20H20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 11H6V15H10V13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	SquareMinusIcon: [
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
					["d", "M5 21H19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 12L16 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 5L21 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 5L3 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 3H19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	SquarePlusIcon: [
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
					["d", "M5 21H19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 16L12 14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 12L16 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 12L10 12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 10L12 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 5L21 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 5L3 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 3H19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	SparkleIcon: [
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
	],
	CloudRunIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					["d", "M2 3.5H8.5L13.5 12H7Z"],
					["opacity", ".55"],
				],
				[],
			],
			["path", [["d", "M7 12H13.5L8.5 20.5H2Z"]], []],
			[
				"path",
				[
					["d", "M14 6.5L22 12H14Z"],
					["opacity", ".55"],
				],
				[],
			],
			["path", [["d", "M14 12H22L14 17.5Z"]], []],
		],
	],
	GooglePubSubIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M18.3 7.452a2.064 2.064 0 1 1 4.128 0 2.064 2.064 0 0 1-4.128 0zM3.636 9.516a2.064 2.064 0 1 0 0-4.128 2.064 2.064 0 0 0 0 4.128zM12 19.872A2.064 2.064 0 1 0 12 24a2.064 2.064 0 0 0 0-4.128zm-5.774-3.151a2.591 2.591 0 0 0-.118-.48c0-.002 0-.004-.002-.006a2.595 2.595 0 0 0-.2-.436l-.004-.008a2.618 2.618 0 0 0-.276-.39l-.001-.001a2.622 2.622 0 0 0-.346-.336 2.603 2.603 0 0 0-1.643-.592A2.628 2.628 0 1 0 6.264 17.1c0-.13-.02-.254-.038-.38zm8.499-2.53c.033-.047.063-.097.094-.147a3.32 3.32 0 0 0 .201-.37c.026-.055.052-.108.074-.164a3.301 3.301 0 0 0 .242-1.234c0-1.51-1.01-2.772-2.388-3.183a3.277 3.277 0 0 0-.42-.1A2.882 2.882 0 0 0 12 8.94c-.183 0-.359.021-.532.054a3.272 3.272 0 0 0-.428.103 3.325 3.325 0 0 0-2.376 3.179c0 .567.155 1.093.405 1.561.028.054.055.108.086.16.062.102.13.198.201.292.039.051.08.099.12.147a3.314 3.314 0 0 0 4.885.196c.135-.135.254-.284.364-.44zm-8.987.608c.473.433.818 1.002.956 1.651l2.575-1.486a3.83 3.83 0 0 1-.946-1.657L5.738 14.8zm5.302-9.21v2.988A3.79 3.79 0 0 1 12 8.44c.329 0 .643.055.948.133v-2.98c-.3.097-.615.163-.948.163-.337 0-.656-.067-.96-.166zm7.317 9.132L15.711 13.2a3.818 3.818 0 0 1-.914 1.683l2.542 1.46a3.115 3.115 0 0 1 1.018-1.622zm2.007-.249c-.58 0-1.112.194-1.547.513a2.633 2.633 0 0 0-.662.701l-.013.024c-.082.13-.155.265-.212.409-.008.02-.012.041-.02.061a2.588 2.588 0 0 0-.124.421 2.628 2.628 0 1 0 2.578-2.129zm-8.862-9.266a2.52 2.52 0 0 0 .99 0A2.626 2.626 0 0 0 12 0a2.627 2.627 0 0 0-.498 5.206z",
					],
				],
				[],
			],
		],
	],
	MysqlDolphinIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 128 128"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "#4F8DB8"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M117.69 98.24c-6.97-.19-12.3.46-16.85 2.38-1.29.55-3.35.56-3.57 2.18.71.75.82 1.86 1.39 2.78 1.09 1.75 2.92 4.11 4.56 5.35 1.79 1.35 3.63 2.79 5.55 3.96 3.41 2.08 7.22 3.27 10.5 5.35 1.94 1.23 3.86 2.78 5.75 4.16.93.68 1.56 1.75 2.77 2.18v-.2c-.64-.81-.8-1.93-1.39-2.78l-2.58-2.58c-2.52-3.34-5.72-6.28-9.12-8.72-2.71-1.95-8.78-4.58-9.91-7.73l-.2-.2c1.92-.22 4.17-.91 5.95-1.39 2.98-.8 5.64-.59 8.72-1.39l4.16-1.19v-.79c-1.55-1.59-2.66-3.71-4.36-5.15-4.44-3.78-9.29-7.55-14.27-10.7-2.77-1.75-6.18-2.88-9.12-4.36-.99-.5-2.72-.76-3.37-1.59-1.54-1.96-2.38-4.45-3.57-6.74-2.49-4.79-4.93-10.02-7.14-15.07-1.5-3.44-2.48-6.83-4.36-9.91-9-14.8-18.69-23.73-33.7-32.51-3.19-1.87-7.04-2.6-11.1-3.57l-6.54-.4c-1.33-.56-2.71-2.18-3.96-2.98C16.98 3.52 4.22-3.31.54 5.67-1.78 11.34 4.02 16.87 6.09 19.75c1.46 2.01 3.32 4.27 4.36 6.54.69 1.49.81 2.98 1.39 4.56 1.44 3.88 2.69 8.11 4.56 11.7.94 1.82 1.98 3.73 3.17 5.35.731 1.98 1.44 2.18 2.97-1.23 1.72-1.3 4.38-1.98 6.54-3.1 9.77-1.93 21.91 2.58 29.14 1.38 2.22 4.64 6.98 9.12 5.16 3.92-1.6 3.04-6.54 4.16-10.9.25-.99.1-1.72.59-2.38v.2l3.57 7.13c2.64 4.25 7.32 8.7 11.3 11.7 2.06 1.55 3.68 4.24 6.34 5.15v-.2h-.2c-.52-.81-1.32-1.14-1.98-1.78-1.55-1.52-3.28-3.41-4.56-5.16-3.61-4.9-6.8-10.27-9.71-15.86-1.39-2.67-2.6-5.61-3.77-8.32-.45-1.05-.45-2.63-1.39-3.17-1.28 1.99-3.17 3.6-4.16 5.95-1.58 3.75-1.79 8.34-2.38 13.08-.35.12-.2.04-.4.2-2.76-.67-3.73-3.51-4.76-5.95-2.59-6.16-3.08-16.09-.79-23.19.59-1.84 3.26-7.62 2.18-9.32-.52-1.69-2.22-2.67-3.17-3.96-1.18-1.6-2.35-3.7-3.17-5.55-2.12-4.8-3.11-10.2-5.35-15.06-1.07-2.32-2.88-4.68-4.36-6.74-1.65-2.29-3.48-3.98-4.76-6.74-.45-.98-1.07-2.56-.4-3.57.21-.68.52-.97 1.19-1.19 1.15-.89 4.35.3 5.55.79 3.18 1.32 5.83 2.58 8.53 4.36 1.29.85 2.6 2.51 4.16 2.97h1.78c2.79.64 5.91.2 8.52.99 4.61 1.4 8.74 3.58 12.49 5.95 11.42 7.21 20.77 17.48 27.16 29.73 1.03 1.97 1.47 3.85 2.38 5.95 1.82 4.22 4.12 8.56 5.94 12.69 1.82 4.11 3.58 8.27 6.15 11.7 1.35 1.8 6.55 2.77 8.92 3.77 1.66.7 4.38 1.43 5.95 2.38 3 1.81 5.91 3.96 8.72 5.95 1.4.99 5.73 3.17 5.95 4.96zm-88.61-75.52c-1.45-.03-2.48.16-3.57.4v.2h.2c.69 1.42 1.92 2.34 2.78 3.57l1.98 4.16.2-.2c1.23-.87 1.79-2.25 1.78-4.36-.49-.52-.56-1.16-.99-1.78-.56-.82-1.66-1.29-2.38-1.98zm0 0",
					],
				],
				[],
			],
		],
	],
	ParenthesesDotsIcon: [
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
					["d", "M8 3L8 3.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 5L6 5.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 7V17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 19L6 19.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 21L8 21.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 3L16 3.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 5L18 5.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 7V17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 19L18 19.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 21L16 21.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 12L8 12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 12L12 12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 12L16 12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	SqlServerIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 128 128"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "#CC2927"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M52.94 0v0c-.43-.06-7.31 2.42-11.74 4.22-5.99 2.44-10.64 4.77-13.5 6.78-.93.66-2.05 1.75-2.48 2.37l-.01-.02a1.42 1.42 0 0 0-.07.15c-.02.04-.05.09-.07.12a1.81 1.81 0 0 0-.12.66l.06.06c.02.21.07.44.17.69.25.62.99 1.38 1.82 2.15 0 0 8.62 8.41 9.67 9.61 4.77 5.5 6.84 10.93 7.03 18.41.12 4.8-.8 9.03-3.06 13.93-4.03 8.8-12.54 18.5-25.65 29.28l.2-.07c-.09.07-.21.17-.29.24-1.57 1.24-3.9 3.56-5.08 5.04-1.76 2.21-3.16 4.55-3.76 6.36-1.07 3.25-.54 6.55 1.51 9.59 2.64 3.88 7.89 7.83 14.01 10.52 3.12 1.38 8.37 3.14 12.32 4.13 6.57 1.67 19.28 3.47 26.27 3.74 1.41.06 3.31.06 3.39 0 .15-.1 1.24-2.17 2.5-4.74 4.3-8.78 7.4-17.01 9.09-24.05 1.01-4.26 1.8-9.94 2.32-16.66.14-1.88.19-8.18.08-10.31-.17-3.49-.48-6.32-.97-9.09a4.17 4.17 0 0 1-.07-.57c15.58-4.63 32.77-8.82 44.19-10.57l1.76-.27-.27-.43c-1.55-2.4-2.62-3.89-3.89-5.48-3.72-4.61-8.23-8.35-13.76-11.45-7.59-4.24-17.42-7.56-29.86-10.02-2.34-.47-7.5-1.36-11.68-2l-.39-.7c-2.29-4.03-4.8-9.03-6.28-12.4-1.14-2.62-2.23-5.64-2.83-7.81C53.19.1 53.15.02 52.94 0Zm-.31.99h.02c.02.02.1.56.17 1.2.33 2.71.93 5.33 1.88 8.16.72 2.13.72 2.02-.12 1.76-1.98-.54-10.83-2.07-17.24-2.96-1.03-.14-1.9-.27-1.9-.29-.08-.08 4.63-2.54 6.7-3.51 2.65-1.22 9.94-4.26 10.48-4.36ZM33.95 9.67l.76.25c4.11 1.4 14.43 3.37 20.13 3.84.64.06 1.18.12 1.2.12.02.02-.52.31-1.22.64-2.75 1.38-5.78 3.06-7.87 4.36-.48.3-.91.55-1.13.65a1193.73 1193.73 0 0 1-1.93-.32l-1.82-1.79a803.54 803.54 0 0 0-7.11-6.84zm-.78.6 2.73 3.41c1.49 1.88 3 3.72 3.33 4.13.29.36.5.62.54.7-1.94-.34-4.01-.71-5.6-1.05-1.16-.25-3.39-.78-5.13-1.38-.18-.07-.39-.15-.58-.22v-.2c.02-1.3 1.67-3.24 4.46-5.21zm23.17 4.65c.01-.01.03-.01.040.08 0 .17.17.4.69.66 1.45 2.71 5.37 3.22 6.12l.06.1a1193.73 1193.73 0 0 1-10.98-1.79 2.86 2.86 0 0 1 .37-.23c2.04-1.12 4.09-2.56 5.91-4.09.45-.37.85-.71.93-.77a.1.1 0 0 1 .04-.04zm-26.14 3.27c.02-.02.33.1.74.23a50.34 50.34 0 0 0 2.81.85 142.91 142.91 0 0 0 2.56.68c1.16.29 2.13.56 2.15.56.14.14 2.09 6.39 2.75 8.8.25.91.45 1.69.43 1.69-.02.02-.23-.31-.49-.76-2.27-3.99-5.85-8.04-10-11.3-.54-.39-.95-.74-.95-.76zm9.51 2.62c0 .04 0 .02.02.02.1 0 .52.06 1.05.17 3.29.74 9.2 1.86 12.98 2.5.64.1 1.14.21 1.14.25 0 .04-.23.17-.52.33-.64.33-3.22 1.86-4.07 2.44-2.15 1.44-4.09 2.98-5.48 4.38a79.99 79.99 0 0 1-1.05 1.03s-.12-.33-.21-.74c-.7-2.69-2.15-6.68-3.47-9.49-.21-.45-.39-.85-.39-.89zm16.8 3.21c.12.04.31.7.7 2.15a31.73 31.73 0 0 1 .93 8.87c-.04.81-.08 1.57-.12 1.67l-.06.19-1.01-.33c-2.07-.66-5.44-1.65-8.33-2.46-1.65-.45-2.98-.85-2.98-.89 0-.12 2.4-2.52 3.43-3.43 1.96-1.73 7.26-5.83 7.44-5.78zm1.33.2c.06-.06 8.02 1.32 11.65 2.01 2.69.52 6.61 1.34 6.84 1.44.12.04-.29.27-1.59.85-5.12 2.31-8.91 4.38-12.69 6.9-.99.66-1.82 1.2-1.84 1.2-.02 0-.04-.56-.04-1.24 0-3.68-.73-7.4-2.09-10.54-.14-.31-.25-.6-.23-.62zm20.6 4.07c.06.06-.19 1.63-.43 2.56-.7 2.89-2.58 7.17-4.88 11.2-.41.72-.78 1.3-.82 1.32-.04.02-.56-.27-1.16-.62-2.25-1.32-4.81-2.56-7.6-3.72-.78-.33-1.45-.6-1.47-.64-.14-.12 6.1-4.24 9.4-6.22 2.62-1.59 6.88-3.95 6.96-3.88zm1.48.23c.17 0 3.7.97 5.54 1.51 4.55 1.36 9.78 3.27 13.19 4.83l1.41.64-.99.23c-8.33 1.92-15.46 4.13-22.34 6.92-.56.23-1.07.42-1.1.42-.04 0 .16-.44.41-.99 2.07-4.4 3.41-8.99 3.74-12.91.02-.37.08-.66.14-.66zm-35.11 8.06c.06-.06 2.75.58 4.21.99 2.21.62 6.9 2.19 6.9 2.3 0 .02-.53.47-1.15 1.01-2.54 2.11-4.98 4.34-7.91 7.17-.87.83-1.61 1.51-1.65 1.51-.04 0-.06-.12-.04-.27.45-3.25.35-7.44-.27-11.68-.06-.54-.12-1.01-.1-1.03zm56.6.06c.04.04-1.24 2.05-2.06 3.19-1.16 1.67-2.87 3.88-6.72 8.72a1289.46 1289.46 0 0 0-5.08 6.41c-.78.97-1.42 1.78-1.44 1.78-.02 0-.27-.35-.54-.78-2.17-3.26-4.77-6.1-7.85-8.66a44.53 44.53 0 0 0-1.43-1.16c-.21-.15-.39-.31-.39-.33 0-.06 3.29-1.47 5.79-2.48 4.38-1.78 10.35-3.91 14.82-5.29 2.34-.73 4.84-1.45 4.88-1.41zm1.49.39c.08-.02.54.21 1.1.54 4.71 2.69 9.32 6.16 12.96 9.73 1.03 1.01 3.56 3.64 3.52 3.66 0 0-.89.08-1.94.16-8.16.62-18.6 2.34-28.64 4.76-.68.15-1.28.29-1.32.29-.04 0 .72-.76 1.67-1.67 5.89-5.68 8.58-9.26 11.76-15.66.45-.95.83-1.76.87-1.82zm-43.15 4.42c.27.06 2.79 1.24 4.69 2.19 1.74.87 4.36 2.27 4.5 2.38.02.02-.91.5-2.05 1.07a135.03 135.03 0 0 0-10.02 5.52c-.93.56-1.7 1.03-1.72 1.03-.08 0-.06-.08.47-1.03 1.74-3.18 3.14-6.97 3.93-10.68.08-.29.15-.48.21-.48zm-2.52.46c.06.06-.6 2.44-1.01 3.74-.8 2.46-2.13 5.54-3.43 7.87-.31.54-.78 1.34-1.03 1.78l-.48.77-1.08-1.04c-1.26-1.22-2.29-1.98-3.6-2.66-.52-.27-.93-.5-.93-.54 0-.16 3.31-3.16 5.85-5.33 1.82-1.57 5.66-4.65 5.71-4.59zm15.4 6.34.95.62c2.17 1.41 4.73 3.29 6.68 4.94 1.1.91 3.23 2.83 3.66 3.29l.23.25-1.57.45c-8.87 2.46-15.73 4.65-23.73 7.59-.89.33-1.65.6-1.71.6-.12 0-.21.1 1.78-1.75 5.12-4.71 9.65-9.9 13.02-14.96zm-4.05 1.01c.04.04-2.61 3.78-4.2 5.89-1.9 2.52-5.27 6.74-7.6 9.49-.97 1.14-1.8 2.09-1.84 2.11-.06.02-.08-.27-.08-.72 0-2.34-.6-4.84-1.65-6.97-.45-.89-.52-1.1-.42-1.2.37-.33 6-3.54 9.57-5.46 2.4-1.28 6.16-3.18 6.22-3.14zM44.1 55.26c.06 0 .5.23 1.01.5a21.28 21.28 0 0 1 3.33 2.25c.04.04-.46.45-1.12.93-1.84 1.32-4.63 3.43-6.26 4.73-1.71 1.36-1.76 1.39-1.57 1.1 1.28-1.96 1.92-3.06 2.6-4.48a36.07 36.07 0 0 0 1.63-4.05c.15-.56.35-.99.39-.99zm6.53 5.11c.1-.02.21.16.73.93 1.1 1.65 1.96 3.86 2.17 5.64l.04.39-2.65 1.03c-4.75 1.84-9.13 3.66-12.09 5.02a217.07 217.07 0 0 0-3.24 1.55c-.95.48-1.72.85-1.72.83 0-.02.6-.47 1.34-1.01 5.79-4.2 10.81-8.82 14.57-13.43.41-.48.78-.93.81-.95zm-3.74v0c.08.08-2.13 2.58-3.64 4.11-3.74 3.82-7.44 6.8-12.03 9.71-.58.37-1.1.7-1.16.73-.14.08.04-.12 2.05-2.31a52.69 52.69 0 0 0 3.35-3.97c.74-.95.87-1.09 1.94-1.84 2.85-2.06 9.42-6.51 9.49-6.44zm25.97 2.3c.27 1.06.78 6.13.92 9.48.04.8.02 1.32-.02 1.32-.15 0-3.27-1.84-5.5-3.24-1.93-1.22-5.58-3.63-6.18-4.11a358.5 358.5 0 0 1 10.78-3.45zm-12.87 4.19c.25.11.64.32 1.4.8 3.99 2.5 9.42 5.52 11.74 6.53.72.31.79.19-.85 1.32-3.53 2.4-7.92 4.76-13.31 7.15-.95.43-1.75.76-1.76.76-.04 0 .08-.49.23-1.07 1.3-4.83 2.04-9.71 2.08-13.62.01-.98.01-1.46.04-1.71l.43-.15zm-2.96 1.05c.09.48.02 4.37-.13 5.49a49.36 49.36 0 0 1-1.78 8.43c-.21.72-.41 1.32-.45 1.36-.08.1-2.73-2.5-3.6-3.51-1.51-1.74-2.69-3.49-3.56-5.19-.4-.79-.99-2.21-1.05-2.52a345.35 345.35 0 0 1 8.59-3.35c.62-.23 1.34-.47 1.99-.71zm-12.6 4.9c.05.07.16.33.27.65.62 1.69 2.01 4.17 3.21 5.75 1.32 1.74 3.04 3.6 4.48 4.83.47.39.89.76.95.81.12.12.15.1-3 1.3-3.66 1.4-7.65 2.79-12.22 4.26a609.84 609.84 0 0 0-3.27 1.07c-.17.06-.11-.04.39-.83 2.27-3.54 5.71-10.5 7.65-15.42.33-.85.66-1.71.72-1.9.03-.1.07-.15.1-.21l.73-.3zm-4.01 1.7c-.13.39-.97 2.15-1.84 3.85-1.88 3.66-3.93 7.27-6.68 11.65-.47.76-.91 1.45-.97 1.53-.1.14-.14.1-.45-.5-.66-1.3-1.2-2.96-1.49-4.5-.29-1.51-.23-4.15.1-5.77.15-.72.22-.99.36-1.16a225.04 225.04 0 0 1 10.98-5.1zm33.48 1.2v.81c0 4.32-.47 10.25-1.14 14.57-.12.76-.21 1.38-.23 1.4 0 0-.56-.16-1.22-.35a49.98 49.98 0 0 1-8.91-3.82c-1.88-1.03-4.61-2.71-4.53-2.79.02-.02.83-.45 1.78-.95 3.8-1.98 7.44-4.11 10.6-6.22 1.18-.79 2.96-2.07 3.35-2.42zm-48.05 5.74c.070.05.16-.06.85a27.51 27.51 0 0 0-.21 2.07c-.15 2.83.31 4.92 1.71 7.79.39.79.7 1.45.68 1.47-.14.12-12.96 3.88-16.99 4.98-1.2.33-2.25.62-2.33.64-.14.04-.15.02-.1-.31.45-2.85 2.62-6.57 5.64-9.71 2.01-2.09 3.62-3.31 6.37-4.88.92-.52 2.07-1.16 3.06-1.71.74-.4 1.48-.8 2.24-1.19zm30.22 5.4h0c.02-.02.48.23 1.04.56 4.15 2.4 9.92 4.63 14.84 5.78l.45.1-.62.35c-2.58 1.43-11.04 4.96-19.7 8.2-1.26.47-2.5.93-2.73 1.03-.23.1-.45.15-.45.14 0-.02.35-.7.8-1.53 2.42-4.53 4.86-10.05 6.1-13.89.15-.37.25-.7.27-.72zm-3.08 1.01h0c.02.02-.14.43-.33.89-1.69 4.09-3.9 8.54-6.72 13.54-.72 1.28-1.32 2.31-1.34 2.31-.02 0-.6-.35-1.3-.78-4.11-2.52-7.75-5.62-10.13-8.62l-.35-.43 1.76-.48c6.32-1.72 11.68-3.58 17.01-5.87.76-.31 1.38-.56 1.39-.56zm19.14 6.69c.02.45-.97 4.44-1.78 7.32-.68 2.42-1.26 4.32-2.33 7.67-.46 1.47-.87 2.69-.89 2.69-.02 0-.14-.02-.25-.06-5.75-1.05-10.91-2.5-15.75-4.44-1.36-.54-3.29-1.42-3.41-1.51-.04-.04 1.12-.58 2.6-1.22 8.82-3.86 17.96-8.23 21.1-10.11.37-.23.66-.35.71-.35zM28.68 96.8c.04.04-2.42 3.58-5.87 8.41-1.2 1.69-2.6 3.66-3.12 4.4a77.47 77.47 0 0 0-1.76 2.6l-.81 1.26-.87-.74c-1.03-.85-2.81-2.67-3.6-3.68-1.67-2.07-2.79-4.26-3.24-6.26-.21-.93-.21-1.39-.02-1.45a1459.31 1459.31 0 0 1 10.31-2.42 861.65 861.65 0 0 0 6.93-1.63c1.12-.27 2.04-.48 2.05-.48zm2.48.95.62.7c2.79 3.12 5.64 5.42 9.09 7.44.62.35 1.09.66 1.05.68-.14.1-11.97 4.3-17.46 6.2a462.5 462.5 0 0 1-5.64 1.96c-.02 0-.19-.12-.39-.25l-.35-.25.56-.81c1.82-2.63 4.11-5.52 9.09-11.53zm15.46 11.06c.02-.02.87.29 1.92.68 2.52.95 4.51 1.55 7.19 2.23 3.29.83 8.06 1.65 10.87 1.88.43.04.66.08.58.13-.14.08-2.98 1.03-5.08 1.69-3.33 1.05-13.5 4.05-21.8 6.43a218.74 218.74 0 0 1-2.92.83c-.19.04-.83-.14-.83-.21 0-.04.47-.64 1.03-1.3 2.79-3.33 5.56-7.05 7.87-10.58.64-.97 1.18-1.76 1.18-1.78zm-3.41.1h0c.02.02-1.36 2.23-3.76 6.03-1.03 1.61-2.17 3.43-2.58 4.07-.39.62-.97 1.59-1.3 2.13l-.56.99-.29-.08c-.7-.2-5.6-1.92-6.9-2.44a48.23 48.23 0 0 1-4.51-2.07c-1.55-.83-3.49-2.07-3.33-2.11.04-.02 2.69-.74 5.89-1.61 8.48-2.31 13.19-3.64 16.27-4.61.56-.17 1.05-.31 1.06-.29zm24.12 5.66h.02c.08.2-3.06 8.91-4.21 11.66-.25.62-.35.78-.48.76-.33-.02-4.88-.66-7.65-1.06-4.82-.74-12.93-2.15-14.96-2.62l-.46-.1 2.89-.66c6.2-1.4 9.18-2.15 12.21-3.08a86.25 86.25 0 0 0 11.41-4.4c.6-.27 1.1-.48 1.24-.5z",
					],
				],
				[],
			],
		],
	],
	SitemapIcon: [
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
					["d", "M12 12V7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8 12H16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 2H13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 4V7H9V4"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 21L17 21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 21L5 21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 19L15 16L21 16L21 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 19L3 16L9 16L9 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 14H18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 14H6.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	GkeIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M10.20 14.35l.007.01-.999 2.41a5.17 5.17 0 0 1-2.07-2.59l2.57-.437.00.005a.44.44 0 0 1 .484.60zm-.833-2.12a.44.44 0 0 0 .173-.756l.002-.011L7.58 9.7a5.14 5.14 0 0 0-.73 3.25l2.51-.725.00-.009zm1.14-1.98a.44.44 0 0 0 .699-.337l.01-.005.15-2.62a5.14 5.14 0 0 0-3.01 1.44l2.14 1.52.004-.002zm.76 2.75l.723.34.722-.347.18-.78-.5-.623h-.804l-.5.62.179.77zm1.5-3.09a.44.44 0 0 0 .7.33l.008.00 2.13-1.51a5.18 5.18 0 0 0-2.99-1.44l.148 2.61.002.00zm10.87 5.97l-5.77 7.18a1.6 1.6 0 0 1-1.24.594l-9.26.003a1.6 1.6 0 0 1-1.24-.596l-5.77-7.18a1.58 1.58 0 0 1-.307-1.34L2.1 5.57c.108-.47.42-.864.86-1.07L11.30.513a1.60 1.60 0 0 1 1.38 0l8.34 3.98c.438.20.755.60.863 1.07l2.06 8.95c.108.47-.005.96-.308 1.34zm-3.28-2.05c-.042-.01-.103-.026-.145-.034-.174-.033-.315-.025-.479-.038-.35-.037-.638-.067-.895-.148-.105-.04-.18-.165-.216-.216l-.201-.059a6.45 6.45 0 0 0-.105-2.33 6.46 6.46 0 0 0-.936-2.16c.052-.047.15-.133.17-.159.00-.09.00-.183.09-.282.19-.185.44-.338.74-.522.14-.084.27-.137.41-.242.03-.024.07-.062.11-.089.24-.191.29-.52.12-.736-.172-.216-.506-.236-.745-.045-.034.02-.08.06-.111.08-.134.11-.217.23-.33.35-.246.25-.45.45-.673.60-.097.05-.239.03-.303.03l-.19.13a6.54 6.54 0 0 0-4.14-2.00l-.012-.223c-.065-.062-.143-.115-.163-.25-.022-.268.01-.557.05-.905.02-.163.06-.298.06-.475.00-.04-.001-.099-.001-.142 0-.306-.224-.555-.5-.555-.275 0-.499.24-.499.55l.001.01c0 .041-.002.09 0 .128.00.177.04.312.06.475.04.348.07.637.05.906a.545.54 0 0 1-.162.25l-.012.21a6.42 6.42 0 0 0-4.16 2.00 8.37 8.37 0 0 1-.18-.128c-.09.01-.18.04-.297-.029-.223-.15-.427-.358-.673-.608-.113-.12-.195-.234-.329-.349-.03-.026-.077-.062-.111-.088a.594.59 0 0 0-.348-.132.48.481 0 0 0-.398.17c-.172.21-.117.54.123.73l.007.00.104.08c.142.10.272.15.414.24.299.18.546.33.743.52.076.08.09.22.1.28l.16.14a6.46 6.46 0 0 0-1.02 4.50l-.208.06c-.055.07-.133.18-.215.21-.257.08-.546.11-.895.14-.164.01-.305.00-.48.03-.037.00-.09.02-.133.03l-.004.00-.007.00c-.295.07-.484.34-.423.60.061.26.349.42.645.36l.007-.001.01-.003.12-.029c.17-.046.29-.113.44-.172.33-.118.60-.217.87-.256.11-.009.23.06.288.10l.217-.037a6.5 6.5 0 0 0 2.88 3.59l-.09.21c.033.08.069.19.044.28-.097.25-.263.51-.452.81-.091.13-.185.24-.268.39-.02.03-.045.09-.064.13-.128.27-.034.59.213.71.24.12.55-.007.69-.282v-.002c.02-.039.04-.09.06-.127.07-.162.09-.301.14-.458.13-.332.20-.68.38-.897.05-.06.13-.082.21-.105l.113-.205a6.45 6.45 0 0 0 4.60.012l.106.19c.086.02.18.04.256.15.136.23.229.50.342.84.05.15.074.29.145.45.016.03.043.09.06.129.13.276.44.402.69.28.247-.118.34-.435.21-.71-.02-.039-.045-.096-.065-.134-.083-.156-.177-.261-.268-.398-.19-.296-.346-.541-.443-.793-.04-.13.00-.21.03-.294-.018-.022-.059-.144-.083-.202a6.49 6.49 0 0 0 2.88-3.62c.064.01.17.03.21.038.07-.05.14-.114.28-.104.26.039.54.13.87.25.154.06.27.128.44.173.03.01.08.019.13.02l.009.00.007.00c.297.06.584-.098.64-.365.06-.266-.128-.537-.423-.608zM16.4 9.70l-1.95 1.74v.005a.44.44 0 0 0 .173.75l.003.01 2.52.728a5.19 5.19 0 0 0-.108-1.67A5.20 5.20 0 0 0 16.4 9.7zm-4.01 5.32a.437.43 0 0 0-.404-.232.44.44 0 0 0-.372.23h-.002l-1.26 2.29a5.16 5.16 0 0 0 3.32.003l-1.27-2.29h-.01zm1.88-1.29a.44.44 0 0 0-.27.03.44.44 0 0 0-.214.57l-.003.00 1.01 2.43a5.15 5.15 0 0 0 2.08-2.61l-2.6-.44-.004.00z",
					],
				],
				[],
			],
		],
	],
	GoogleCloudMonoIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 128 128"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M80.6 40.3h.4l-.2-.2 14-14v-.3c-11.8-10.4-28.1-14-43.2-9.5C36.5 20.8 24.9 32.8 20.7 48c.2-.1.5-.2.8-.2 5.2-3.4 11.4-5.4 17.9-5.4 2.2 0 4.3.2 6.4.6.1-.1.2-.1.3-.1 9-9.9 24.2-11.1 34.6-2.6h-.1z",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M108.1 47.8c-2.3-8.5-7.1-16.2-13.8-22.1L80 39.9c6 4.9 9.5 12.3 9.3 20v2.5c16.9 0 16.9 25.2 0 25.2H63.9v20h-.1l.1.2h25.4c14.6.1 27.5-9.3 31.8-23.1 4.3-13.8-1-28.8-13-36.9z",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M39 107.9h26.3V87.7H39c-1.9 0-3.7-.4-5.4-1.1l-15.2 14.6v.2c6 4.3 13.2 6.6 20.7 6.6z",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M40.2 41.9c-14.9.1-28.1 9.3-32.9 22.8-4.8 13.6 0 28.5 11.8 37.3l15.6-14.9c-8.6-3.7-10.6-14.5-4-20.8 6.6-6.4 17.8-4.4 21.7 3.8L68 55.2C61.4 46.9 51.1 42 40.2 42.1z",
					],
				],
				[],
			],
		],
	],
	StopwatchIcon: [
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
					["d", "M12 2V6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 2H15"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 18L20 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 18L4 10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 8H18.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 20H18.01"],
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
					["d", "M12 14H12.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 4H20.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 6H22.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 12H10.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6 20H6.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 6L8 6"],
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
		],
	],
	ShieldCheckIcon: [
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
					["d", "M6 3H18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M8.01 20L8 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M6.01 18L6 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16.01 20L16 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18.01 18L18 18"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 16V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M20 16V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 22H14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 14.01V14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 12.01V12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 10.01V10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 8.01V8"],
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
		],
	],
	AionLabsIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M8.303.964c.038.016.064.01.076-.016a.487.487 0 00.048-.034L8.76.66a2.845 2.845 0 011.5-.575c.078-.007.148-.007.211 0 .12.01.19.016.21.016.01 0 .02 0 .029.004a.416.416 0 00.148.021c.016 0 .031.002.046.006a.303.303 0 00.15.015c.34-.085.613-.133.82-.144.191-.01.42.012.688.067.454.092.864.288 1.23.588.048.04.13.114.249.223.007.006.015.01.024.011.037.006.07.001.099-.015a1.06 1.06 0 01.716-.12l.367.022c.235.023.446.083.632.18.096.048.223.128.383.238a.05.05 0 00.025.009c.047.003.091-.035.125-.03.033.004.068-.02.106-.024a3.47 3.47 0 01.815 0c.135.015.264.047.386.097.306.127.583.296.83.507.3.255.57.55.765.9.133.239.22.455.263.65.021.1.046.224.073.372.002.01.005.018.009.028.07.172.167.335.23.508.04.113.07.208.087.286.024.108.047.239.069.394.006.051.018.108.034.17a.142.142 0 00.046.073c.273.233.49.514.617.841.037.095.06.207.068.337.013.199.02.41-.042.598-.046.143-.076.23-.089.26a.085.085 0 00-.005.047c.016.105.023.18.02.225-.013.152-.021.265-.026.34a1.14 1.14 0 01-.121.43c-.247.5-.7.773-1.25.844a.236.236 0 00-.09.038c-.018.01-.02.034-.007.07a.062.062 0 01.003.023 2.592 2.592 0 01-.068.463c-.068.3-.205.55-.41.748a1.68 1.68 0 01-.742.41c-.036.01-.116.022-.24.034a.033.033 0 00-.027.022c-.01.033 0 .097-.017.15-.023.069-.006.17-.026.239-.02.065-.015.134-.024.215-.006.044-.023.163-.053.357a12.686 12.686 0 01-1.535 4.4c-.105.184-.23.366-.363.564a.07.07 0 00-.01.052c.089.486.185.956.32 1.416.08.272.182.523.383.715.057.054.155.121.296.203.63.367 1.277.656 1.985.963a.019.019 0 01.007.005.02.02 0 01.004.008.02.02 0 010 .009 2.052 2.052 0 01-.135.176c-.757.875-1.549 1.639-2.448 2.277a7.977 7.977 0 01-2.65 1.23.417.417 0 01-.087.017c-.01 0-.019.002-.027.008-.04.027-.092.01-.138.037a.063.063 0 01-.033.008.275.275 0 00-.12.02.081.081 0 01-.028.007c-.14.004-.259.029-.387.031-.327.007-.686.034-1.02.025a8.142 8.142 0 01-.646-.037 5.625 5.625 0 01-.613-.13 6.23 6.23 0 01-1.764-.73 4.407 4.407 0 01-1.199-1.098 1.296 1.296 0 01-.276-.625.734.734 0 00-.029-.163.679.679 0 00-.022-.192.17.17 0 01-.006-.045.648.648 0 00-.008-.127c-.025-.112-.02-.18-.037-.31a22.16 22.16 0 00-.173-1.086.667.667 0 01-.012-.104c-.002-.053-.027-.086-.026-.14a.28.28 0 00-.023-.129.051.051 0 01-.005-.027.358.358 0 00-.016-.134c-.023-.06-.008-.123-.036-.198a.1.1 0 01-.006-.036.33.33 0 00-.012-.115c-.026-.069-.008-.136-.04-.208a.063.063 0 01-.004-.027.357.357 0 00-.015-.124c-.023-.064-.006-.12-.03-.18-.021-.052-.004-.119-.028-.17-.025-.055-.008-.125-.032-.187-.019-.047-.003-.093-.023-.148-.02-.06-.008-.13-.032-.184-.016-.036-.01-.079-.019-.125l-.05-.267a.98.98 0 00-.061-.24.022.022 0 00-.02-.014.278.278 0 01-.07-.019 2.243 2.243 0 01-.69-.397 1.597 1.597 0 01-.48-.695 2.39 2.39 0 01-.104-.4c-.03-.17-.147-.303-.217-.43a1.498 1.498 0 01-.142-.384c-.01-.041-.004-.115-.028-.147a.017.017 0 01.004-.024c.018-.013.024-.044.016-.092-.006-.037-.024-.055-.053-.054a.03.03 0 01-.013-.002.03.03 0 01-.01-.008c-.26-.308-.456-.554-.545-.897a2.623 2.623 0 01-.086-.483 4.554 4.554 0 00-.021-.279.02.02 0 01-.005-.014.497.497 0 00.046-.183.323.323 0 00-.056-.251.123.123 0 01-.023-.052l-.078-.394a.114.114 0 01-.002-.037c.017-.149.028-.237.034-.264.045-.212.126-.406.244-.583a.025.025 0 00.004-.018.026.026 0 00-.01-.015 2.888 2.888 0 01-.927-1.357A2.66 2.66 0 013 8.36c.001-.148.008-.28.02-.397a2.276 2.276 0 01.656-1.395c.166-.168.356-.318.572-.452.037-.022.053-.053.05-.092a.417.417 0 00-.024-.103.077.077 0 01-.005-.028 20.28 20.28 0 01.004-1.105c.006-.126.038-.28.096-.462.175-.556.438-1.015.79-1.379.215-.222.449-.4.7-.535.162-.087.314-.142.396-.252.173-.233.373-.45.6-.65.312-.274.68-.447 1.103-.519.104-.017.229-.01.345-.027zm.106.32l-.24-.047a1.42 1.42 0 00-.59.115c-.674.296-1.225.917-1.414 1.616-.045.17-.053.305-.075.51a.087.087 0 01-.035.06c-.113.084-.26.186-.363.302a2.227 2.227 0 00-.355.53 1.45 1.45 0 00-.133.55.745.745 0 00-.009.282l.016.24a.016.016 0 01-.015.017.264.264 0 00-.131.046c-.305.204-.512.52-.631.862-.042.12-.118.326-.078.436a.042.042 0 00.043.027.043.043 0 00.018-.005.557.557 0 00.194-.177c.237-.315.489-.593.86-.758a1.79 1.79 0 011.076-.127 7.415 7.415 0 01.518.114.012.012 0 00.007-.016 1.69 1.69 0 01-.134-.5.827.827 0 010-.142l.015-.128a1.89 1.89 0 00.61 1.269c.254.231.557.338.898.375.237.026.46.028.671.006a.32.32 0 01.128-.009 1.735 1.735 0 001.225-.678v-.006a.013.013 0 00-.005-.006.012.012 0 00-.006-.002l-.434-.048a4.718 4.718 0 00-.369-.141c-.138-.046-.271-.05-.41-.068-.453-.058-.831-.371-.914-.841-.028-.318.026-.623.244-.865.065-.072.143-.148.233-.227a.088.088 0 00.03-.096.056.056 0 01-.001-.026l.067-.312.174-.325a.014.014 0 00-.014-.02 1.24 1.24 0 00-.877.605c-.186.309-.264.69-.152 1.03a.004.004 0 01-.002.005h-.003l-.002-.002c-.222-.418-.247-.911.03-1.309.253-.36.775-.712 1.247-.67a.03.03 0 00.024-.01l.203-.214a2.28 2.28 0 01.443-.352c.112-.068.259-.128.379-.194a.016.016 0 00.001-.027.784.784 0 00-.267-.118 2.217 2.217 0 00-.79-.046c-.45.054-.943.304-1.302.596a.012.012 0 01-.013.002.013.013 0 01-.008-.01c0-.01.001-.018.005-.024.16-.231.342-.419.546-.562.507-.357 1.193-.4 1.768-.204.128.061.25.133.367.215a.219.219 0 00.073.037.52.52 0 00.287-.064.36.36 0 00.187-.269.23.23 0 00-.004-.128.065.065 0 00-.016-.023c-.057-.05-.085-.106-.085-.168 0-.12.075-.2.199-.177a.478.478 0 01.168.076.605.605 0 01.11.435l.004.004a.011.011 0 00.011.002c.214-.088.363-.079.641-.091a.019.019 0 01.014.005.019.019 0 01.005.013v.21a.011.011 0 01-.01.011c-.24.026-.398.053-.475.08-.558.201-.93.583-1.113 1.144-.105.38-.085.752.06 1.113.126.301.32.55.578.745.442.332 1.015.404 1.552.291.111-.023.209-.07.3-.11a.004.004 0 00.002-.003.005.005 0 000-.006l-.004-.001a1.237 1.237 0 01-.87-.314 1.726 1.726 0 01-.213-.235.79.79 0 00.546.172c.226-.01.468-.102.6-.297a.024.024 0 00.003-.02.025.025 0 00-.005-.009.025.025 0 00-.008-.006c-.497-.249-.698-.726-.654-1.268a.134.134 0 01.032-.054.014.014 0 01.023.009l.003.038a.537.537 0 00.053.19c.147.316.371.546.67.686.47.221 1.122.188 1.551-.114a.712.712 0 00.258-.32.417.417 0 00-.043-.41c-.122-.153-.27-.194-.44-.123-.117.048-.187.133-.296.164-.55.159-1.123-.414-.907-.96a.503.503 0 01.346-.266l.1.004a1.048 1.048 0 00-.146.241c-.103.23-.046.492.174.62.12.058.235.06.342.004.095-.05.145-.141.213-.22a.394.394 0 01.273-.14c.486-.046.884.347 1.062.77.061.201.09.398.084.591l-.037.278-.024.106c-.08.118-.138.254-.177.406-.07.28.045.482.245.662a.008.008 0 00.01 0 .008.008 0 00.003-.008.977.977 0 01.01-.526l.11-.242c.147-.198.335-.327.563-.387a1.613 1.613 0 01.412-.047.012.012 0 00.004-.003.013.013 0 00.003-.005V3.87c-.049-.26-.03-.483.054-.669.264-.578.864-.658 1.409-.47.262.091.474.247.699.383a.011.011 0 00.012 0 .011.011 0 00.004-.005.454.454 0 00-.048-.163 2.018 2.018 0 00-1.123-1.113 2.008 2.008 0 00-.558-.102.306.306 0 01.276-.158.01.01 0 00.006-.002.01.01 0 00.003-.006.01.01 0 00-.007-.01 2.14 2.14 0 01-.19-.064 1.71 1.71 0 00-1.061-.062.033.033 0 00-.02.05l.087.152a.044.044 0 00.048.021c.057-.012.135-.02.235-.025a.694.694 0 01.415.108 1.79 1.79 0 00-1.339.788.201.201 0 01-.02-.04c-.015-.034-.041-.05-.054-.08-.022-.052.029-.156.058-.2.107-.16.245-.297.412-.41a.021.021 0 00.008-.027.74.74 0 00-.18-.248 1.394 1.394 0 00-.693-.434c-.512-.143-1.04-.067-1.457.256a9.16 9.16 0 00-.268.221c-.046.04-.093.053-.14.04a.798.798 0 00-.52.017c-.307.12-.544.371-.593.71-.004.03-.002.07-.006.104a.026.026 0 01-.02.022 1.331 1.331 0 00-.347.153c-.308.174-.442.441-.403.8.01.083.036.169.079.259l-.052.216c-.064-.083-.137-.169-.18-.255a.988.988 0 01-.035-.814c.08-.214.284-.44.534-.39a.167.167 0 01.119.08.026.026 0 00.025.012.025.025 0 00.02-.019c.01-.036.02-.082.026-.138.074-.558.534-1.062 1.136-1.077.039 0 .077-.012.11-.034l.284-.182a.012.012 0 00.005-.008v-.005a2.488 2.488 0 00-1.269-.735 2.637 2.637 0 00-1.47.116.132.132 0 01-.08.003A2.257 2.257 0 009.123.71a2.2 2.2 0 00-.24.165c-.157.138-.316.274-.474.41zm.965 2.196a1.215 1.215 0 00-.388.183.453.453 0 00-.112.11.057.057 0 00-.01.025c-.061.389-.04.825.21 1.152.455.6 1.252.715 1.936.475.121-.042.246-.124.356-.174a.012.012 0 00.005-.004.011.011 0 00.001-.007.011.011 0 00-.008-.01 1.759 1.759 0 01-.896-.665 1.446 1.446 0 01-.25-.516c-.094-.44-.04-.879.164-1.317.084-.166.184-.323.302-.47a.248.248 0 00.033-.051.01.01 0 000-.006.01.01 0 00-.006-.01 1.398 1.398 0 00-.517.167c-.42.238-.757.638-.82 1.118zm-4.8 2.044c.088-.12.184-.224.285-.31a.128.128 0 00.045-.087l.03-.347c.083-.455.288-.84.613-1.152a1.54 1.54 0 01.302-.211.032.032 0 00.016-.03 1.823 1.823 0 01.121-.713.015.015 0 00-.003-.016.015.015 0 00-.016-.003.59.59 0 00-.076.037 2.595 2.595 0 00-.825.75 3.317 3.317 0 00-.53 1.224 2.961 2.961 0 00-.036.947.005.005 0 00.009 0l.064-.089zm13.143-.942c-.136.069-.282.106-.438.11-.306.01-.548-.09-.7-.357a.018.018 0 00-.027-.005l-.085.071c-.322.25-.288.603-.04.893.168.198.38.326.634.384.448.101.9.014 1.242-.295.233-.21.37-.47.41-.782.01-.071.02-.158.028-.26a.077.077 0 01.063-.069.263.263 0 01.11.012c.435.119.668.58.77.984.003.016 0 .024-.01.025-.121.005-.25.017-.386.035a.016.016 0 00-.013.013l.001.01a.016.016 0 00.007.006c.143.076.274.283.258.445-.016.163-.034.329-.053.5-.015.139-.01.249-.009.422 0 .01.002.02.006.03.04.114.082.196.217.19.01 0 .018-.003.027-.007.166-.069.242-.24.286-.403.08-.282.069-.554-.035-.816a1.831 1.831 0 00-.112-.21 1.95 1.95 0 01-.108-.211 1.833 1.833 0 00-.02-.744c-.16-.667-.796-1.429-1.555-1.175a.81.81 0 00-.56.84c.013.111.06.243.092.364zm-2.6.49a2.111 2.111 0 01-.429.433c-.291.217-.615.349-.97.394-.157.02-.335.01-.48.014a.618.618 0 00-.315.11c-.162.104-.35.23-.53.316-.347.166-.71.25-1.09.25a8.8 8.8 0 01-.405-.007.302.302 0 00-.252.105 38.7 38.7 0 01-.397.443l-.322.215-.319.16c-.223.114-.4.269-.53.466-.119.18-.17.362-.26.626a1.477 1.477 0 01-.374.58l-.337.198a.017.017 0 00-.007.02c.012.033.032.078.058.136.11.24.135.491.077.756a.989.989 0 01-.217.414.846.846 0 01-.428.221c-.456.069-.788-.255-.978-.629l-.002-.002h-.003l-.002.002-.001.003.067.316c.028.131.095.297.17.435.054.096.104.19.15.283-.013.121-.063.2-.15.238-.1.043-.238-.005-.338-.048a15.309 15.309 0 01-.44-.2.372.372 0 01-.205-.209c-.058-.165-.107-.359-.173-.494a1.045 1.045 0 00-.588-.533.36.36 0 00-.121-.024c-.008-.013-.01-.017-.004-.012l-.03-.485c-.024-.32.024-.64.37-.756.48-.057.528.515.79.722a.013.013 0 00.015 0 .012.012 0 00.006-.012c-.044-.306-.09-.588-.296-.818a.518.518 0 00-.465-.176c-.416.047-.58.386-.622.762-.021.193-.024.371-.009.535.023.356.12.796.163 1.006.047.233.11.455.188.665.07.19.212.426.299.554.13.194.301.362.51.504.366.246.76.297 1.186.153.058.431.147.86.266 1.29.026.092.057.177.093.253.186.518.478.98.876 1.384.255.26.515.48.78.664.007.012.033.03.077.05a.6.6 0 00.106.094c.484.329 1.004.613 1.56.852l.239.103c.197.087.36.15.485.191.295.094.462.146.502.158.39.113.79.172 1.2.175.312.004.598-.049.869-.184.207-.105.424-.32.505-.553.162-.468-.062-.95-.47-1.214a1.54 1.54 0 00-.665-.287 1.85 1.85 0 00-.492-.029c.07-.11.115-.178.135-.204.133-.175.385-.209.584-.177.167.028.309.053.426.077.223.045.397-.064.352-.313a.362.362 0 00-.179-.272 2.06 2.06 0 00-.65-.223.944.944 0 00-.268-.02c-.22.028-.395.05-.524.063a.519.519 0 00-.287.152.412.412 0 01-.145-.06.216.216 0 01-.063-.107c.05-.172.161-.264.336-.275a.097.097 0 01.07.026c.162.152.362.091.557.024a.99.99 0 01.715.01c.087.034.298.125.42.112.142-.016.214-.1.215-.251a.062.062 0 00-.03-.054 4.639 4.639 0 01-.144-.1.14.14 0 01-.033-.036 3.76 3.76 0 01-.135-.218c-.085-.147-.238-.192-.397-.23a.506.506 0 01-.246-.154c.1-.196.272-.313.515-.349a.596.596 0 01.32.037c.269.11.46.186.575.227.312.11.649.115.818-.213a.6.6 0 00.086-.284c.02-.508.05-1.347.092-2.517l.039-1.008c.01-.273.084-.515.323-.668.19-.11.433-.097.645-.112.428-.03.485-.436.408-.77-.064-.356-.321-.667-.634-.838a2.432 2.432 0 00-.531-.207 3.244 3.244 0 01-.357-.148 2 2 0 01-.355-.263v-.004l.004-.002h.004l.202.091c.137.056.28.076.428.06.309-.032.485-.33.288-.6-.13-.18-.364-.324-.53-.439a2.118 2.118 0 01-.405-.376 1.616 1.616 0 01-.288-.516.004.004 0 00-.005 0l-.001.002a1.46 1.46 0 01-.241.55zm3.914.445c-.011.02-.018.064-.031.082-.183.239-.33.338-.595.532a.794.794 0 00-.257.319.01.01 0 00.009.01c.105.008.212.002.322-.018.501-.093.61-.479.567-.921l-.002-.005a.008.008 0 00-.009-.002.008.008 0 00-.004.003zM3.266 7.891c-.048.295-.042.593.018.893.09.507.311 1.007.687 1.366.048.046.106.09.175.13.014.014.028.018.042.011.107-.05.223-.125.35-.223a.031.031 0 00.012-.025v-.09a.071.071 0 00-.066-.07.834.834 0 01-.453-.177 1.05 1.05 0 01-.356-.521 6.047 6.047 0 00-.07-.203l.017-.145a.007.007 0 01.015 0c.036.23.177.527.395.634a.29.29 0 00.309-.025.779.779 0 00.173-.35.079.079 0 00-.032-.081c-.355-.24-.385-.6-.078-.88.358-.325.868-.352 1.273-.125.034.019.087.053.157.104.05.036.102.072.155.107.075.074.17.158.285.25.2.163.408.24.67.25.411.017.748-.127 1.01-.432.127-.147.187-.294.292-.512a.919.919 0 01.611-.511.007.007 0 00-.004-.01l-.318-.069a1.755 1.755 0 00-.358-.045 1.02 1.02 0 00-.534.081c-.196.09-.357.28-.555.334-.267.073-.471-.005-.611-.233a.34.34 0 01-.034-.158l.009-.007c.213.276.51.121.558-.178a.66.66 0 00-.106-.473c-.213-.316-.518-.463-.916-.441-.397.022-.773.248-1.022.548-.192.232-.402.547-.709.458-.226-.066-.235-.278-.19-.477a.01.01 0 00-.015-.01c-.09.056-.165.115-.224.176a2.093 2.093 0 00-.562 1.129zm3.221 1.627a.99.99 0 00.174.337c.054.068.115.132.181.193.08.157.178.264.293.321.26.13.554.024.658-.251.078-.237.047-.444-.092-.62a.626.626 0 00-.435-.239 2.97 2.97 0 00-.527.017l-.35-.21a.01.01 0 00-.011 0 .01.01 0 00-.005.011c.016.16.054.307.114.44zM4.23 10.86a1.16 1.16 0 00-.08.132c-.074.158-.109.323-.102.495.01.26.196.672.528.6a.343.343 0 00.249-.202.3.3 0 00.042-.15 1.418 1.418 0 00-.093-.4 2.793 2.793 0 01-.16-.754.036.036 0 00-.008-.019.017.017 0 00-.01-.006c-.004-.001-.008 0-.012.002a1.674 1.674 0 00-.354.302zm.109 2.45a1.921 1.921 0 00.337.464c.002.001.003.002.005.001a.013.013 0 00.01-.004l.08-.096a1.21 1.21 0 01.622-.114c.03.003.06.005.091.004l.15.082c.084.057.17.115.257.176a2.12 2.12 0 01.272.259h.003a.005.005 0 00.002-.002v-.003a1.983 1.983 0 00-.133-.625 1.117 1.117 0 00-.635-.61 33.41 33.41 0 00-.275-.285.482.482 0 00-.413-.152.752.752 0 01-.516-.07.01.01 0 00-.008.004 1.79 1.79 0 00.151.971zm2.137 1.902c.006.025.008.037.006.037.023.307.058.602.106.887.045.443.092.81.14 1.1l.419 2.536c.092.552.126.872.185 1.457.022.214.095.407.218.578.203.283.438.53.705.744.459.367.97.646 1.534.838.444.168.906.28 1.385.339.476.054.963.053 1.461-.004.395-.038.794-.12 1.196-.245.119-.038.304-.104.554-.2a.891.891 0 00.114-.06.588.588 0 00.128-.046c.311-.15.613-.308.905-.473a2.43 2.43 0 00.276-.185v-.007a.012.012 0 00-.005-.005.011.011 0 00-.007-.002c-.716.065-1.372-.067-2.035-.383-.574-.273-1.088-.718-1.552-1.21a26.147 26.147 0 01-1.289-1.46l-2.286-2.761a9.577 9.577 0 01-.753-1.023 4.608 4.608 0 01-.577-1.342l-.147-.61a.018.018 0 00-.019-.014c-.45.038-.68.566-.688.958a3.17 3.17 0 00.026.556zm-1.47-1.214a.506.506 0 00-.027.551.638.638 0 00.231.251.105.105 0 00.088.011c.302-.095.58-.148.887-.034h.004a.008.008 0 00.004-.002.007.007 0 00.001-.008 1.908 1.908 0 00-.302-.475 1.227 1.227 0 00-.432-.357.533.533 0 00-.21-.065c-.098-.003-.18.04-.244.128zm.96 2.255a.76.76 0 00.244.08l.14.016a.033.033 0 00.031-.018 2.273 2.273 0 00-.07-.799.02.02 0 00-.007-.01.019.019 0 00-.012-.004c-.179.008-.356.033-.533.074-.009-.01-.023-.016-.043-.018a1.019 1.019 0 01-.384-.434.012.012 0 00-.017.009c-.069.454.279.892.652 1.104z",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M7.126 3.698a2.128 2.128 0 00-.016 1.07l-.091-.023c-.31-.215-.696-.139-.966.09a.02.02 0 01-.018.005.978.978 0 00-.294-.023c.15-.23.352-.383.604-.457.083-.024.187-.044.31-.058a.023.023 0 00.018-.015c.091-.24.242-.436.453-.59zM14.187 8.01c.415.181.695.507.724.97a.035.035 0 01-.009.025l-.018.021c-.241.232-.463.462-.735.66-.23.165-.56.315-.849.297a.335.335 0 01-.24-.112.968.968 0 01-.038-.37.043.043 0 00-.038-.047.448.448 0 01-.148-.045c.06-.134.094-.251.102-.352.029-.327-.238-.5-.53-.538a1.515 1.515 0 00-.7.074c-.1.03-.193.073-.279.126a.756.756 0 00-.164.14 9.013 9.013 0 00-.144.164.02.02 0 00-.004.012c0 .005.002.01.005.013.015.016.022.031.021.046l-.178.074-.172-.031a6.66 6.66 0 00-.755-.142 3.515 3.515 0 01-.465-.116c.215.01.404 0 .565-.033a2.67 2.67 0 00.502-.156c.564-.236.991-.43 1.538-.496a.041.041 0 00.035-.032c.047-.211.19-.285.397-.327.138-.029.313-.035.526-.02.378.028.715.066 1.05.196z",
					],
				],
				[],
			],
		],
	],
	AnthropicIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z",
					],
				],
				[],
			],
		],
	],
	ArceeIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M13.236 2.377L2.751 20.493H0L11.863 0l1.373 2.377zm3.554 6.156l-9.606 11.96H4.13L15.511 6.32l1.279 2.212zm6.908 11.96H14.05l8.406-2.151 1.242 2.15zm-3.42-5.922l-7.843 5.92H8.482l10.597-7.997 1.2 2.077z",
					],
				],
				[],
			],
		],
	],
	BaiduIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M8.859 11.735c1.017-1.71 4.059-3.083 6.202.286 1.579 2.284 4.284 4.397 4.284 4.397s2.027 1.601.73 4.684c-1.24 2.956-5.64 1.607-6.005 1.49l-.024-.009s-1.746-.568-3.776-.112c-2.026.458-3.773.286-3.773.286l-.045-.001c-.328-.01-2.38-.187-3.001-2.968-.675-3.028 2.365-4.687 2.592-4.968.226-.288 1.802-1.37 2.816-3.085zm.986 1.738v2.032h-1.64s-1.64.138-2.213 2.014c-.2 1.252.177 1.99.242 2.148.067.157.596 1.073 1.927 1.342h3.078v-7.514l-1.394-.022zm3.588 2.191l-1.44.024v3.956s.064.985 1.44 1.344h3.541v-5.3h-1.528v3.979h-1.46s-.466-.068-.553-.447v-3.556zM9.82 16.715v3.06H8.58s-.863-.045-1.126-1.049c-.136-.445.02-.959.088-1.16.063-.203.353-.671.951-.85H9.82zm9.525-9.036c2.086 0 2.646 2.06 2.646 2.742 0 .688.284 3.597-2.309 3.655-2.595.057-2.704-1.77-2.704-3.08 0-1.374.277-3.317 2.367-3.317zM4.24 6.08c1.523-.135 2.645 1.55 2.762 2.513.07.625.393 3.486-1.975 4-2.364.515-3.244-2.249-2.984-3.544 0 0 .28-2.797 2.197-2.969zm8.847-1.483c.14-1.31 1.69-3.316 2.931-3.028 1.236.285 2.367 1.944 2.137 3.37-.224 1.428-1.345 3.313-3.095 3.082-1.748-.226-2.143-1.823-1.973-3.424zM9.425 1c1.307 0 2.364 1.519 2.364 3.398 0 1.879-1.057 3.4-2.364 3.4s-2.367-1.521-2.367-3.4C7.058 2.518 8.118 1 9.425 1z",
					],
				],
				[],
			],
		],
	],
	BoltIcon: [
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
					["d", "M15 19L15 20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 17V22H13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 16L17 17"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 15L3 15L3 13"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 13L19 14"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 10L5 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 9L21 9V11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M7 7L7 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 4L9 5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 7V2H11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	CrewAiIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M12.482.18C7.161 1.319 1.478 9.069 1.426 15.372c-.051 5.527 3.1 8.68 8.68 8.627 6.716-.05 14.259-6.87 12.09-10.9-.672-1.292-1.396-1.344-2.687-.207-1.602 1.395-1.654.31-.207-2.893 1.757-3.98 1.705-5.322-.31-7.544C17.03.388 14.962-.388 12.482.181Zm5.322 2.068c2.273 2.015 2.376 4.236.465 8.42-1.395 3.1-2.17 3.515-3.824 1.86-1.24-1.24-1.343-3.46-.258-6.044 1.137-2.635.982-3.1-.568-1.653-3.72 3.358-6.458 9.765-5.424 12.503.464 1.189.825 1.395 2.737 1.395 2.79 0 6.303-1.705 7.957-3.926 1.756-2.274 2.79-2.274 2.79-.052 0 3.875-6.459 8.627-11.625 8.627-6.251 0-9.351-4.752-7.491-11.47.878-2.995 4.443-7.904 7.077-9.66 3.255-2.17 5.684-2.17 8.164 0z",
					],
				],
				[],
			],
		],
	],
	EffectIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M11.846.007a.8.8 0 0 0-.312.103L.454 6.346a.8.8 0 0 0-.397.855.8.8 0 0 0 .408.78L3.99 9.976 1.033 11.64a.76.76 0 0 0-.374.838c-.033.265.07.541.378.715l10.546 5.967a.8.8 0 0 0 .61.073.8.8 0 0 0 .27-.094l10.548-5.968c.31-.175.412-.454.376-.72a.76.76 0 0 0-.383-.79l-3.01-1.693 3.554-2.012a.8.8 0 0 0 .399-.836.8.8 0 0 0-.412-.753L12.455.13a.8.8 0 0 0-.28-.097.8.8 0 0 0-.227-.033m6.482 10.853 2.78 1.566-9.205 5.21-9.21-5.213 2.76-1.554 5.99 3.387a.83.83 0 0 0 .638.076.8.8 0 0 0 .285-.098zm3.572 6.03a.75.75 0 0 0-.35.098l-9.67 5.47-9.635-5.45a.75.75 0 0 0-1.01.267.717.717 0 0 0 .27.99l9.976 5.644a.75.75 0 0 0 .372.098c.079 0 .294-.026.46-.117l9.978-5.645a.716.716 0 0 0 .27-.99.75.75 0 0 0-.661-.364",
					],
				],
				[],
			],
		],
	],
	GoogleIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 32 32"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M29.44,16.318c0-.993-.089-1.947-.255-2.864h-13.185v5.422h7.535c-.331,1.744-1.324,3.22-2.813,4.213v3.525h4.544c2.647-2.444,4.175-6.033,4.175-10.296Z",
					],
					["opacity", ".4"],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M16,30c3.78,0,6.949-1.247,9.265-3.385l-4.544-3.525c-1.247,.84-2.838,1.349-4.722,1.349-3.64,0-6.733-2.456-7.84-5.765l-2.717,2.09-1.941,1.525c2.304,4.569,7.025,7.713,12.498,7.713Z",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M8.16,18.66c-.28-.84-.445-1.731-.445-2.66s.165-1.82,.445-2.66v-3.615H3.502c-.955,1.884-1.502,4.009-1.502,6.275s.547,4.391,1.502,6.275h3.332s1.327-3.615,1.327-3.615Z",
					],
					["opacity", ".4"],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M16,7.575c2.062,0,3.895,.713,5.358,2.087l4.009-4.009c-2.431-2.265-5.587-3.653-9.367-3.653-5.473,0-10.195,3.144-12.498,7.725l4.658,3.615c1.107-3.309,4.2-5.765,7.84-5.765Z",
					],
				],
				[],
			],
		],
	],
	HaystackIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M2.0084 0C.8992 0 0 .8992 0 2.0084v19.9832C0 23.1006.8992 24 2.0084 24h19.9832C23.1006 24 24 23.1007 24 21.9916V2.0084C24 .8992 23.1007 0 21.9916 0Zm9.9624 3.84c3.4303 0 6.2108 2.7626 6.2108 6.1709v6.4875a.2688.2688 0 0 1-.2697.2681c-1.3425 0-2.4306-1.0811-2.4306-2.415v-4.3409c0-1.9265-1.572-3.488-3.5105-3.488s-3.424 1.562-3.424 3.488v1.608a.2633.2633 0 0 0 .259.2681h1.5394a.2693.2693 0 0 0 .2753-.263V9.9453c0-.7412.6044-1.3414 1.3503-1.3414s1.3502.6002 1.3502 1.3414V20.029a.2747.2747 0 0 1-.2807.2682c-1.3362 0-2.4198-1.0766-2.4198-2.4043v-3.2307a.2747.2747 0 0 0-.2753-.268H8.8114a.2637.2637 0 0 0-.2646.263v1.0789c0 1.3338-1.1746 2.4152-2.517 2.4152a.2688.2688 0 0 1-.2698-.268v-7.8724c0-3.4083 2.7805-6.1709 6.2108-6.1709Z",
					],
				],
				[],
			],
		],
	],
	HuggingFaceIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M12.025 1.13c-5.77 0-10.449 4.647-10.449 10.378 0 1.112.178 2.181.503 3.185.064-.222.203-.444.416-.577a.96.96 0 0 1 .524-.15c.293 0 .584.124.84.284.278.173.48.408.71.694.226.282.458.611.684.951v-.014c.017-.324.106-.622.264-.874s.403-.487.762-.543c.3-.047.596.06.787.203s.31.313.4.467c.15.257.212.468.233.542.01.026.653 1.552 1.657 2.54.616.605 1.01 1.223 1.082 1.912.055.537-.096 1.059-.38 1.572.637.121 1.294.187 1.967.187.657 0 1.298-.063 1.921-.178-.287-.517-.44-1.041-.384-1.581.07-.69.465-1.307 1.081-1.913 1.004-.987 1.647-2.513 1.657-2.539.021-.074.083-.285.233-.542.09-.154.208-.323.4-.467a1.08 1.08 0 0 1 .787-.203c.359.056.604.29.762.543s.247.55.265.874v.015c.225-.34.457-.67.683-.952.23-.286.432-.52.71-.694.257-.16.547-.284.84-.285a.97.97 0 0 1 .524.151c.228.143.373.388.43.625l.006.04a10.3 10.3 0 0 0 .534-3.273c0-5.731-4.678-10.378-10.449-10.378M8.327 6.583a1.5 1.5 0 0 1 .713.174 1.487 1.487 0 0 1 .617 2.013c-.183.343-.762-.214-1.102-.094-.38.134-.532.914-.917.71a1.487 1.487 0 0 1 .69-2.803m7.486 0a1.487 1.487 0 0 1 .689 2.803c-.385.204-.536-.576-.916-.71-.34-.12-.92.437-1.103.094a1.487 1.487 0 0 1 .617-2.013 1.5 1.5 0 0 1 .713-.174m-10.68 1.55a.96.96 0 1 1 0 1.921.96.96 0 0 1 0-1.92m13.838 0a.96.96 0 1 1 0 1.92.96.96 0 0 1 0-1.92M8.489 11.458c.588.01 1.965 1.157 3.572 1.164 1.607-.007 2.984-1.155 3.572-1.164.196-.003.305.12.305.454 0 .886-.424 2.328-1.563 3.202-.22-.756-1.396-1.366-1.63-1.32q-.011.001-.02.006l-.044.026-.01.008-.03.024q-.018.017-.035.036l-.032.04a1 1 0 0 0-.058.09l-.014.025q-.049.088-.11.19a1 1 0 0 1-.083.116 1.2 1.2 0 0 1-.173.18q-.035.029-.075.058a1.3 1.3 0 0 1-.251-.243 1 1 0 0 1-.076-.107c-.124-.193-.177-.363-.337-.444-.034-.016-.104-.008-.2.022q-.094.03-.216.087-.06.028-.125.063l-.13.074q-.067.04-.136.086a3 3 0 0 0-.135.096 3 3 0 0 0-.26.219 2 2 0 0 0-.12.121 2 2 0 0 0-.106.128l-.002.002a2 2 0 0 0-.09.132l-.001.001a1.2 1.2 0 0 0-.105.212q-.013.036-.024.073c-1.139-.875-1.563-2.317-1.563-3.203 0-.334.109-.457.305-.454m.836 10.354c.824-1.19.766-2.082-.365-3.194-1.13-1.112-1.789-2.738-1.789-2.738s-.246-.945-.806-.858-.97 1.499.202 2.362c1.173.864-.233 1.45-.685.64-.45-.812-1.683-2.896-2.322-3.295s-1.089-.175-.938.647 2.822 2.813 2.562 3.244-1.176-.506-1.176-.506-2.866-2.567-3.49-1.898.473 1.23 2.037 2.16c1.564.932 1.686 1.178 1.464 1.53s-3.675-2.511-4-1.297c-.323 1.214 3.524 1.567 3.287 2.405-.238.839-2.71-1.587-3.216-.642-.506.946 3.49 2.056 3.522 2.064 1.29.33 4.568 1.028 5.713-.624m5.349 0c-.824-1.19-.766-2.082.365-3.194 1.13-1.112 1.789-2.738 1.789-2.738s.246-.945.806-.858.97 1.499-.202 2.362c-1.173.864.233 1.45.685.64.451-.812 1.683-2.896 2.322-3.295s1.089-.175.938.647-2.822 2.813-2.562 3.244 1.176-.506 1.176-.506 2.866-2.567 3.49-1.898-.473 1.23-2.037 2.16c-1.564.932-1.686 1.178-1.464 1.53s3.675-2.511 4-1.297c.323 1.214-3.524 1.567-3.287 2.405.238.839 2.71-1.587 3.216-.642.506.946-3.49 2.056-3.522 2.064-1.29.33-4.568 1.028-5.713-.624",
					],
				],
				[],
			],
		],
	],
	IbmIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					["clip-rule", "evenodd"],
					[
						"d",
						"M24 16.333V17h-3.158v-.667H24zm-7.579 0V17h-3.158v-.667h3.158zm2.464 0L18.63 17l-.25-.667h.504zm-7.075 0a2.528 2.528 0 01-1.717.667h-5.04v-.667h6.757zm-7.389 0V17H0v-.667h4.421zm12-1.333v.667h-3.158V15h3.158zm2.958 0l-.246.667h-1L17.885 15h1.494zm-6.937 0c-.057.237-.148.46-.265.667H5.053V15h7.39zm-8.02 0v.667H0V15h4.421zM24 15v.667h-3.158V15H24zm-1.263-1.333v.666h-1.895v-.666h1.895zm-6.316 0v.666h-1.895v-.666h1.895zm3.453 0l-.248.666h-1.989l-.25-.666h2.487zm-7.52 0c.056.212.088.435.088.666h-2.337v-.666h2.249zm-4.143 0v.666H6.316v-.666H8.21zm-5.053 0v.666H1.263v-.666h1.895zm19.579-1.334V13h-1.895v-.667h1.895zm-6.316 0V13h-1.895v-.667h1.895zm3.948 0l-.247.667h-2.987l-.245-.667h3.48zm-8.792 0c.218.188.405.414.55.667H6.315v-.667h5.26zm-8.42 0V13H1.264v-.667h1.895zM18.456 11l.177.539.176-.539h3.929v.667h-1.895v-.613l-.215.613H16.63l-.209-.613v.613h-1.895V11h3.929zM3.158 11v.667H1.263V11h1.895zm8.968 0a2.555 2.555 0 01-.55.667h-5.26V11h5.81zm10.61-1.333v.666h-3.709l.224-.666h3.486zm-4.722 0l.224.666h-3.712v-.666h3.488zm-5.572 0c0 .23-.032.454-.088.666h-2.249v-.666h2.337zm-4.231 0v.666H6.316v-.666H8.21zm-5.053 0v.666H1.263v-.666h1.895zm14.419-1.334l.22.667h-4.534v-.667h4.314zm6.423 0V9h-4.536l.229-.667H24zm-11.823 0c.117.206.208.43.265.667h-7.39v-.667h7.125zm-7.756 0V9H0v-.667h4.421zM17.133 7l.224.667h-4.094V7h3.87zM24 7v.667h-4.089L20.13 7H24zM10.093 7c.662 0 1.264.253 1.717.667H5.053V7h5.04zM4.42 7v.667H0V7h4.421z",
					],
				],
				[],
			],
		],
	],
	InceptionIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M14.767 1H7.884L1 7.883v6.884h6.884V7.883h6.883V1zM9.234 23h6.882L23 16.116V9.233h-6.884v6.883H9.234V23z",
					],
				],
				[],
			],
		],
	],
	KwaipilotIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					["clip-rule", "evenodd"],
					[
						"d",
						"M11.765.03C5.327.03.108 5.25.108 11.686c0 3.514 1.556 6.665 4.015 8.804L9.89 8.665h6.451L9.31 23.083c.807.173 1.63.26 2.455.26 6.438 0 11.657-5.22 11.657-11.658S18.202.028 11.765.028V.03z",
					],
				],
				[],
			],
		],
	],
	LangchainIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M13.796 0a6.93 6.93 0 0 0-4.91 2.019L5.451 5.455l3.273 3.27 3.432-3.432a2.284 2.284 0 0 1 3.277 0 2.28 2.28 0 0 1 0 3.275L12 12.001l3.273 3.273 3.433-3.435c2.692-2.692 2.692-7.127 0-9.82A6.92 6.92 0 0 0 13.796 0m-5.07 8.728-3.433 3.434c-2.692 2.693-2.692 7.126 0 9.819A6.92 6.92 0 0 0 10.203 24a6.93 6.93 0 0 0 4.911-2.02l3.432-3.432-3.271-3.272-3.433 3.433a2.284 2.284 0 0 1-3.277 0 2.28 2.28 0 0 1 0-3.276L12 12z",
					],
				],
				[],
			],
		],
	],
	LiquidIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M12.028 8.546l-.008.005 3.03 5.25a3.94 3.94 0 01.643 2.162c0 .754-.212 1.46-.58 2.062l6.173-1.991L11.63 0 9.304 3.872l2.724 4.674zM6.837 24l4.85-4.053h-.013c-2.219 0-4.017-1.784-4.017-3.984 0-.794.235-1.534.64-2.156l2.865-4.976-2.381-4.087L2 16.034 6.83 24h.007zM13.737 19.382h-.001L8.222 24h8.182l4.148-6.769-6.815 2.151z",
					],
				],
				[],
			],
		],
	],
	MeituanIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					["clip-rule", "evenodd"],
					[
						"d",
						"M.507 19.883a.507.507 0 01-.489-.642L4.29 3.745a1.013 1.013 0 011.533-.578l5.622 3.687a1.013 1.013 0 001.11 0L18.2 3.165a1.013 1.013 0 011.532.58l4.25 15.497a.506.506 0 01-.49.64H18.07a6.297 6.297 0 001.53-4.115v-.177a6.09 6.09 0 00-1.513-4.017l-.697-3.495a.438.438 0 00-.694-.266L14.07 9.781a.748.748 0 01-.654.121 5.156 5.156 0 00-2.833 0 .746.746 0 01-.653-.121L7.302 7.81a.435.435 0 00-.688.269l-.675 3.652a5.36 5.36 0 00-1.539 3.76v.333c0 1.474.527 2.9 1.488 4.02l.032.038H.507z",
					],
				],
				[],
			],
			[
				"path",
				[["d", "M9.213 16.843h1.52v-3.546h-1.29l-.23 3.546zm5.573 0h-1.52v-3.546h1.29l.23 3.546z"]],
				[],
			],
		],
	],
	MiniMaxIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M16.278 2c1.156 0 2.093.927 2.093 2.07v12.501a.74.74 0 00.744.709.74.74 0 00.743-.709V9.099a2.06 2.06 0 012.071-2.049A2.06 2.06 0 0124 9.1v6.561a.649.649 0 01-.652.645.649.649 0 01-.653-.645V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v7.472a2.037 2.037 0 01-2.048 2.026 2.037 2.037 0 01-2.048-2.026v-12.5a.785.785 0 00-.788-.753.785.785 0 00-.789.752l-.001 15.904A2.037 2.037 0 0113.441 22a2.037 2.037 0 01-2.048-2.026V18.04c0-.356.292-.645.652-.645.36 0 .652.289.652.645v1.934c0 .263.142.506.372.638.23.131.514.131.744 0a.734.734 0 00.372-.638V4.07c0-1.143.937-2.07 2.093-2.07zm-5.674 0c1.156 0 2.093.927 2.093 2.07v11.523a.648.648 0 01-.652.645.648.648 0 01-.652-.645V4.07a.785.785 0 00-.789-.78.785.785 0 00-.789.78v14.013a2.06 2.06 0 01-2.07 2.048 2.06 2.06 0 01-2.071-2.048V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v3.8a2.06 2.06 0 01-2.071 2.049A2.06 2.06 0 010 12.9v-1.378c0-.357.292-.646.652-.646.36 0 .653.29.653.646V12.9c0 .418.343.757.766.757s.766-.339.766-.757V9.099a2.06 2.06 0 012.07-2.048 2.06 2.06 0 012.071 2.048v8.984c0 .419.343.758.767.758.423 0 .766-.339.766-.758V4.07c0-1.143.937-2.07 2.093-2.07z",
					],
				],
				[],
			],
		],
	],
	MoonshotIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M1.052 16.916l9.539 2.552a21.007 21.007 0 00.06 2.033l5.956 1.593a11.997 11.997 0 01-5.586.865l-.18-.016-.044-.004-.084-.009-.094-.01a11.605 11.605 0 01-.157-.02l-.107-.014-.11-.016a11.962 11.962 0 01-.32-.051l-.042-.008-.075-.013-.107-.02-.07-.015-.093-.019-.075-.016-.095-.02-.097-.023-.094-.022-.068-.017-.088-.022-.09-.024-.095-.025-.082-.023-.109-.03-.062-.02-.084-.025-.093-.028-.105-.034-.058-.019-.08-.026-.09-.031-.066-.024a6.293 6.293 0 01-.044-.015l-.068-.025-.101-.037-.057-.022-.08-.03-.087-.035-.088-.035-.079-.032-.095-.04-.063-.028-.063-.027a5.655 5.655 0 01-.041-.018l-.066-.03-.103-.047-.052-.024-.096-.046-.062-.03-.084-.04-.086-.044-.093-.047-.052-.027-.103-.055-.057-.03-.058-.032a6.49 6.49 0 01-.046-.026l-.094-.053-.06-.034-.051-.03-.072-.041-.082-.05-.093-.056-.052-.032-.084-.053-.061-.039-.079-.05-.07-.047-.053-.035a7.785 7.785 0 01-.054-.036l-.044-.03-.044-.03a6.066 6.066 0 01-.04-.028l-.057-.04-.076-.054-.069-.05-.074-.054-.056-.042-.076-.057-.076-.059-.086-.067-.045-.035-.064-.052-.074-.06-.089-.073-.046-.039-.046-.039a7.516 7.516 0 01-.043-.037l-.045-.04-.061-.053-.07-.062-.068-.06-.062-.058-.067-.062-.053-.05-.088-.084a13.28 13.28 0 01-.099-.097l-.029-.028-.041-.042-.069-.07-.05-.051-.05-.053a6.457 6.457 0 01-.168-.179l-.08-.088-.062-.07-.071-.08-.042-.049-.053-.062-.058-.068-.046-.056a7.175 7.175 0 01-.027-.033l-.045-.055-.066-.082-.041-.052-.05-.064-.02-.025a11.99 11.99 0 01-1.44-2.402zm-1.02-5.794l11.353 3.037a20.468 20.468 0 00-.469 2.011l10.817 2.894a12.076 12.076 0 01-1.845 2.005L.657 15.923l-.016-.046-.035-.104a11.965 11.965 0 01-.05-.153l-.007-.023a11.896 11.896 0 01-.207-.741l-.03-.126-.018-.08-.021-.097-.018-.081-.018-.09-.017-.084-.018-.094c-.026-.141-.05-.283-.071-.426l-.017-.118-.011-.083-.013-.102a12.01 12.01 0 01-.019-.161l-.005-.047a12.12 12.12 0 01-.034-2.145zm1.593-5.15l11.948 3.196c-.368.605-.705 1.231-1.01 1.875l11.295 3.022c-.142.82-.368 1.612-.668 2.365l-11.55-3.09L.124 10.26l.015-.1.008-.049.01-.067.015-.087.018-.098c.026-.148.056-.295.088-.442l.028-.124.02-.085.024-.097c.022-.09.045-.18.07-.268l.028-.102.023-.083.03-.1.025-.082.03-.096.026-.082.031-.095a11.896 11.896 0 011.01-2.232zm4.442-4.4L17.352 4.59a20.77 20.77 0 00-1.688 1.721l7.823 2.093c.267.852.442 1.744.513 2.665L2.106 5.213l.045-.065.027-.04.04-.055.046-.065.055-.076.054-.072.064-.086.05-.065.057-.073.055-.07.06-.074.055-.069.065-.077.054-.066.066-.077.053-.06.072-.082.053-.06.067-.074.054-.058.073-.078.058-.06.063-.067.168-.17.1-.098.059-.056.076-.071a12.084 12.084 0 012.272-1.677zM12.017 0h.097l.082.001.069.001.054.002.068.002.046.001.076.003.047.002.06.003.054.002.087.005.105.007.144.011.088.007.044.004.077.008.082.008.047.005.102.012.05.006.108.014.081.01.042.006.065.01.207.032.07.012.065.011.14.026.092.018.11.022.046.01.075.016.041.01L14.7.3l.042.01.065.015.049.012.071.017.096.024.112.03.113.03.113.032.05.015.07.02.078.024.073.023.05.016.05.016.076.025.099.033.102.036.048.017.064.023.093.034.11.041.116.045.1.04.047.02.06.024.041.018.063.026.04.018.057.025.11.048.1.046.074.035.075.036.06.028.092.046.091.045.102.052.053.028.049.026.046.024.06.033.041.022.052.029.088.05.106.06.087.051.057.034.053.032.096.059.088.055.098.062.036.024.064.041.084.056.04.027.062.042.062.043.023.017c.054.037.108.075.161.114l.083.06.065.048.056.043.086.065.082.064.04.03.05.041.086.069.079.065.085.071c.712.6 1.353 1.283 1.909 2.031L7.222.994l.062-.027.065-.028.081-.034.086-.035c.113-.045.227-.09.341-.131l.096-.035.093-.033.084-.03.096-.031c.087-.03.176-.058.264-.085l.091-.027.086-.025.102-.03.085-.023.1-.026L9.04.37l.09-.023.091-.022.095-.022.09-.02.098-.021.091-.02.095-.018.092-.018.1-.018.091-.016.098-.017.092-.014.097-.015.092-.013.102-.013.091-.012.105-.012.09-.01.105-.01c.093-.01.186-.018.28-.024l.106-.008.09-.005.11-.006.093-.004.1-.004.097-.002.099-.002.197-.002z",
					],
				],
				[],
			],
		],
	],
	MorphIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M7.941 2c.23 0 .452.073.638.21.186.136.325.328.397.55l.593 1.814c.073.221.212.413.397.55.186.136.409.21.638.21h2.791c.23 0 .452-.074.638-.21a1.11 1.11 0 00.397-.55l.594-1.815a1.11 1.11 0 01.397-.55c.185-.136.408-.209.637-.209h1.7c.23 0 .453.073.639.21.185.136.324.328.397.55l.652 1.994c.118.361.41.635.77.728l2.957.752c.236.06.446.199.596.394.15.195.23.436.231.684v9.376c0 .248-.081.488-.231.684a1.09 1.09 0 01-.595.394l-2.957.752a1.086 1.086 0 00-.477.263 1.114 1.114 0 00-.293.465l-.653 1.994a1.11 1.11 0 01-.396.55c-.186.136-.41.21-.638.21h-1.702c-.229 0-.452-.073-.637-.21a1.11 1.11 0 01-.397-.55l-.364-1.11a1.131 1.131 0 01.15-1.002 1.074 1.074 0 01.885-.462h2.85c.29 0 .567-.116.772-.325.204-.208.32-.49.32-.785V6.444c0-.294-.116-.577-.32-.785a1.08 1.08 0 00-.771-.326h-3.273c-.29 0-.567.117-.772.326-.204.208-.32.49-.32.785v7.778c0 .295-.114.578-.319.786a1.08 1.08 0 01-.771.325h-2.182a1.08 1.08 0 01-.771-.325 1.122 1.122 0 01-.32-.786V6.444c0-.294-.115-.577-.32-.785a1.081 1.081 0 00-.77-.326H5.454c-.29 0-.567.117-.772.326-.204.208-.32.49-.32.785v11.112c0 .294.116.577.32.785.205.209.482.326.772.326h2.85a1.075 1.075 0 01.885.461 1.122 1.122 0 01.15 1.001l-.364 1.112a1.11 1.11 0 01-.397.55c-.185.136-.408.209-.637.209H6.24c-.229 0-.452-.073-.638-.21a1.11 1.11 0 01-.397-.55l-.652-1.994a1.114 1.114 0 00-.294-.465 1.086 1.086 0 00-.477-.263l-2.956-.752a1.09 1.09 0 01-.595-.394A1.124 1.124 0 010 16.688V7.312c0-.248.081-.489.231-.684.15-.195.36-.334.595-.394l2.957-.753c.178-.045.342-.136.477-.263.134-.127.235-.287.293-.464l.653-1.995a1.11 1.11 0 01.397-.55C5.788 2.075 6.01 2 6.24 2h1.701z",
					],
				],
				[],
			],
		],
	],
	NousResearchIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M5.938 12.835c.127-.039.285.02.373.143.028.038.036.092.046.14.003.014-.02.033-.04.05-.124-.098-.24-.194-.354-.291-.011-.01-.016-.027-.025-.042zM8.396 9.412c.195-.032.39-.06.588-.05a.54.54 0 01.148.026c.202.071.402.147.601.224.028.01.05.036.075.055l-.013.027a9.203 9.203 0 01-.26-.089c-.115-.038-.213-.077-.315-.098-.25-.05-.25-.046-.292-.014l.574.144c.275.139.55.276.823.417.042.022.09.057.107.098.026.06.063.076.117.072.066-.006.132-.017.213-.027l-.04.086c.051.08.142.02.216.064-.074.13-.247.09-.334.199l.061.074-.12.087c0 .106-.038.168-.306.243l.026.085-.196.042.07.124h-.25l-.007.137c-.081-.01-.161-.018-.244-.027l-.053.123c-.027-.008-.052-.011-.073-.023-.067-.038-.128-.056-.195.006-.019.017-.063.014-.093.008-.026-.006-.05-.029-.07-.042-.11.095-.11.095-.208.003-.057.046-.12.074-.186.011-.063.027-.123-.02-.178-.014-.07.007-.097-.035-.133-.07l-.13.033c-.013-.236-.194-.19-.34-.203.005-.072.05-.092.095-.094a.474.474 0 01.159.022c.164.05.32.12.496.138.203.021.405.029.601-.015.265-.059.52-.149.707-.365.049-.056.083-.127.117-.195.019-.038.02-.084-.02-.116a1.397 1.397 0 00-.382-.217c.024.12-.031.182-.115.221 0 .014-.004.025 0 .03.08.115.084.16-.007.267a1.39 1.39 0 01-.218.211.477.477 0 01-.641-.05 1.36 1.36 0 01-.133-.152c-.078-.107-.076-.108-.033-.236-.165-.08-.128-.226-.104-.364.008-.05.028-.096.049-.163-.04.014-.067.017-.087.032a.897.897 0 00-.316.357c-.007.016-.01.034-.02.047-.012.015-.034.038-.045.035-.02-.006-.037-.027-.05-.045-.008-.012-.007-.032-.012-.057h-.126l.053-.172a14.82 14.82 0 00-.039-.049l.11-.284c-.06.026-.091.044-.124.051-.03.007-.064 0-.095 0 0-.031-.01-.07.004-.092.149-.22.305-.428.593-.476z",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M8.06 10.788c-.003-.038-.004-.075.037-.062.016.006.034.048.028.067-.01.04-.038.032-.064-.005z",
					],
				],
				[],
			],
			[
				"path",
				[
					["clip-rule", "evenodd"],
					[
						"d",
						"M11.981.009c.226-.012.453-.011.679 0 .247.01.495.024.74.062.401.064.798.157 1.19.273.463.138.92.299 1.356.511a7.31 7.31 0 012.948 2.642c.292.469.536.963.739 1.479.219.556.446 1.11.623 1.683.204.654.329 1.326.458 1.997.097.504.182 1.01.29 1.511.156.722.329 1.44.494 2.16.186.812.4 1.615.63 2.415.102.355.193.713.282 1.072.11.436.202.876.254 1.323.031.278.066.557.073.837a7.56 7.56 0 01-.017.88c-.037.413-.1.818-.226 1.212a5.017 5.017 0 01-.915 1.649l-.13.156.018.023c.043-.023.088-.041.127-.068.2-.138.373-.307.531-.49.4-.46.721-.973.975-1.529a3.59 3.59 0 00.325-1.72c-.024-.424-.097-.834-.3-1.213-.013-.027-.015-.06-.03-.121.05.035.082.048.101.072.107.13.22.258.315.398.33.494.46 1.052.486 1.64a3.75 3.75 0 01-.47 1.97c-.36.655-.887 1.14-1.526 1.506-.193.111-.394.21-.595.308-.157.078-.248.211-.318.365a.522.522 0 00-.033.406.359.359 0 01.013.139c-.005.077-.077.155-.14.162-.054.006-.125-.043-.15-.116a1.206 1.206 0 01-.06-.233c-.04-.314-.155-.6-.308-.87a3.906 3.906 0 00-.73-.91 2.129 2.129 0 00-.897-.524 4.093 4.093 0 00-.692-.131c-.075-.008-.15-.04-.22.01.18.06.363.11.538.18.434.173.82.43 1.18.728.308.255.58.543.794.884.098.155.186.315.227.496.027.123.042.25.067.375.013.062-.002.109-.053.144-.047.033-.122.034-.163-.01a.455.455 0 01-.08-.14c-.03-.073-.038-.159-.078-.225a7.314 7.314 0 00-1.423-1.664c-.16-.137-.329-.26-.537-.323-.376-.114-.753-.203-1.15-.154-.213.025-.427.032-.64.053a1.6 1.6 0 00-.736.278 5.14 5.14 0 00-.834.72c-.329.342-.642.699-.955 1.055-.136.155-.264.319-.314.531a5.227 5.227 0 00-.012.051.096.096 0 01-.09.076h-.31c-.046 0-.082-.048-.072-.094.023-.108.045-.216.07-.324.075-.325.19-.635.368-.917.024-.039.04-.088.104-.08l.01.049.027.077c.28-.435.571-.834.996-1.135.283-.204.584-.378.89-.55a.196.196 0 00-.098-.002c-.162.043-.325.084-.485.134-.402.124-.764.33-1.11.566-.147.1-.298.193-.414.333a7.314 7.314 0 00-1.07 1.767.845.845 0 00-.04.12.075.075 0 01-.072.056h-.494c-.04 0-.062-.051-.036-.082.123-.14.246-.282.377-.415.275-.281.58-.532.777-.884.027-.048.063-.09.095-.135.238-.333.54-.607.818-.902.082-.086.175-.16.26-.24.029-.027.053-.057.079-.085l-.018-.025-.135.041c-.034.017-.07.031-.102.05-.248.144-.494.292-.743.433-.408.23-.825.439-1.209.711-.281.2-.591.358-.889.533-.02.012-.044.015-.08.028-.015-.135.143-.201.108-.336-.033.014-.064.02-.085.038-.111.096-.227.19-.328.296-.148.157-.284.325-.425.488-.125.143-.25.286-.373.431A.153.153 0 019.89 24H8.762a.316.316 0 00.016-.042c.028-.09.085-.172.083-.28-.091-.018-.162.001-.212.077a4.45 4.45 0 00-.136.215c-.01.016-.024.03-.042.03h-.093c-.019 0-.029-.022-.017-.037.071-.088.14-.178.209-.268.001-.002-.006-.012-.012-.024-.014.004-.03.006-.045.013-.176.09-.352.181-.527.274a.363.363 0 01-.168.042H5.202c-.026 0-.039-.036-.019-.053.21-.178.402-.374.558-.605.335-.496.538-1.047.667-1.629.004-.02-.003-.043-.006-.091-.037.048-.059.072-.076.1a1.943 1.943 0 01-.334.415c-.28.258-.59.448-.983.464-.297.012-.588 0-.865-.127-.46-.21-.722-.57-.794-1.072-.025-.17-.017-.171-.182-.219A3.513 3.513 0 011.97 20.6a2.286 2.286 0 01-.808-1.13 3.569 3.569 0 01-.16-1.245c.002-.034.016-.067.024-.1.032.023.046.043.05.066.033.153.059.308.096.46.086.355.257.664.516.92.258.256.571.419.91.532.358.118.717.138 1.07-.016a1.89 1.89 0 00.621-.452c.328-.348.533-.76.648-1.223.009-.034.005-.071.007-.11-.015.006-.026.006-.03.011-.031.05-.064.1-.093.152-.284.502-.679.887-1.196 1.135-.351.17-.718.255-1.11.159a1.607 1.607 0 01-.971-.64 2.006 2.006 0 01-.368-.924 2.903 2.903 0 01.02-.886c.05-.439.466-1.17.742-1.271-.02.063-.035.112-.053.16-.043.116-.097.227-.13.345a1.901 1.901 0 00-.05.82c.033.212.09.416.204.6.147.236.346.407.62.465.11.023.225.014.338.018a.576.576 0 00.386-.131c.164-.128.282-.292.366-.481.168-.375.24-.777.309-1.179.05-.296.093-.594.133-.893.039-.281.071-.563.104-.845.026-.232.048-.464.074-.696.024-.228.052-.455.076-.683.024-.227.047-.455.069-.683.013-.14.022-.28.034-.42l.037-.417c.022-.25.041-.5.065-.748.008-.082-.02-.132-.09-.177a2.46 2.46 0 01-.492-.418c-.1-.109-.188-.228-.282-.342-.035-.042-.056-.097-.116-.118a2.084 2.084 0 00.275.597c.06.092.131.176.196.265.063.086.182.115.234.226-.028.003-.046.01-.06.006a4.74 4.74 0 01-.22-.057 2.71 2.71 0 01-1.287-.819c-.435-.487-.656-1.076-.71-1.723a5.206 5.206 0 01.014-1.06c.072-.602.22-1.186.45-1.745.155-.376.338-.741.526-1.102.205-.393.466-.75.765-1.076.512-.559 1.104-1.024 1.726-1.448.717-.49 1.478-.898 2.277-1.233C8.244.828 8.767.632 9.31.494c.655-.166 1.31-.33 1.982-.415.229-.03.458-.058.688-.07zm-1.847 22.82c-.07.06-.147.111-.207.18-.238.27-.464.549-.668.869l-.044.108a.177.177 0 00.093-.057c.174-.19.351-.378.519-.574.104-.122.195-.255.288-.386.024-.034.03-.08.046-.12l-.027-.02zm1.65-3.695a5.51 5.51 0 00-.653.593l-.37.386a.963.963 0 01-.377.25 1.372 1.372 0 01-.467.09c-.044 0-.087.006-.151.012.028.058.043.097.064.131.15.242.301.482.45.724.136.22.276.438.399.666.068.125.105.267.156.404.077.027.14-.018.202-.048.29-.135.579-.274.867-.412.213-.101.437-.186.636-.31.347-.215.68-.455 1.018-.685.015-.01.026-.028.042-.046-.023-.019-.038-.037-.056-.044-.287-.111-.527-.3-.77-.482a5.319 5.319 0 01-.506-.42 1.757 1.757 0 01-.41-.653c-.019-.049-.045-.095-.075-.156zm-5.847.264c-.06.096-.097.194-.132.293a3.38 3.38 0 01-.555 1.01c-.2.25-.455.412-.762.493-.23.06-.464.076-.7.07-.048-.002-.097.002-.158.005.016.04.021.066.035.085.1.145.23.246.4.295.157.046.316.034.498.023.181-.037.343-.115.485-.234.238-.199.402-.454.536-.732.175-.363.264-.751.342-1.144.01-.053.008-.11.011-.164zm14.945-4.586c.008.029.016.057.027.107.024.155.051.31.072.464.03.219.067.437.078.657.017.344.027.689-.014 1.033-.037.315-.063.633-.116.946a6.153 6.153 0 01-.46 1.518c-.008.018-.01.039-.02.082.047-.03.077-.042.098-.064.085-.083.17-.167.248-.255.271-.305.458-.66.596-1.043.18-.498.228-1.011.145-1.531-.103-.65-.33-1.263-.597-1.881a9.055 9.055 0 00-.024-.055l-.033.022zM5.797 8.29a.26.26 0 00.018.153c.124.251.25.501.379.75.025.049.066.09.03.163-.284.06-.578.119-.88.255.059.038.097.06.132.087.042.032.112.058.09.12-.01.033-.075.048-.117.072.017.01.043.021.067.036.166.102.33.207.447.368.138.192.229.404.188.644-.079.469-.306.85-.69 1.132-.054.04-.106.083-.161.122a.243.243 0 00-.103.245.77.77 0 00.055.195c.083.196.22.35.375.492.083.076.159.164.222.257a.37.37 0 01.025.377c-.023.05-.05.099-.076.148-.03.06-.028.111.022.162.041.042.08.089.112.138.038.058.078.079.147.05a.486.486 0 01.333-.006c.16.046.302.126.444.21.13.077.264.149.4.219.067.035.14.05.219.026.071-.022.124.01.145.076.02.064-.003.108-.074.139-.07.03-.137.063-.209.088-.1.035-.201.073-.314.077-.013-.107.11-.088.127-.159-.206-.126-.643-.145-.801-.034.063.112.035.21-.096.313-.13-.1-.025-.202.002-.3a.209.209 0 00-.249.17c-.015.101.067.216.178.224.108.007.218-.005.326-.012.06-.005.12-.027.199 0-.103.123-.248.127-.357.19.002.05.07.086.019.131-.053.048-.095-.001-.132-.03-.08-.063-.16-.126-.231-.197a.474.474 0 01-.157-.311.52.52 0 00-.043-.172c-.032-.074-.032-.137.033-.19-.018-.03-.028-.053-.045-.072a1.222 1.222 0 01-.196-.369c-.053-.137-.046-.264.048-.381.024-.03.05-.06.064-.095a.664.664 0 00.047-.168c.017-.165-.064-.287-.182-.387-.186-.156-.36-.322-.46-.551-.005-.011-.024-.017-.037-.026-.011.017-.024.027-.025.038-.019.185-.045.37-.052.557-.014.377.058.743.162 1.104.118.41.289.798.488 1.173.267.502.537 1.002.812 1.5.055.098.13.189.208.27.198.202.452.272.724.273.202 0 .404-.006.605-.026.295-.03.59-.073.884-.113.183-.025.365-.057.548-.08.21-.026.38.073.522.21.16.156.305.327.447.5.22.265.397.56.554.867.05.098.07.1.147.03.13-.121.26-.242.394-.36.067-.059.088-.12.067-.213a3.535 3.535 0 01-.085-.796c.002-.157.006-.314.018-.471.015-.224.03-.45.06-.672a59.114 59.114 0 01.362-2.298c.087-.493.182-.984.268-1.477.06-.347.118-.694.162-1.043.034-.273.055-.55.063-.825.011-.332.003-.665.002-.998 0-.077.004-.155-.01-.23-.028-.142-.01-.155-.162-.19a5.826 5.826 0 00-.607-.107c-.146-.018-.207-.053-.221-.19-.006-.049-.025-.098-.041-.146-.009-.025-.024-.048-.046-.09l-.025.264c-.009.096-.029.116-.127.115-.055 0-.11-.008-.164-.008-.476 0-.952-.008-1.426.032-.095.008-.173-.015-.226-.103-.04-.066-.088-.126-.134-.186-.063-.084-.086-.093-.182-.06-.195.068-.388.138-.582.21a2.71 2.71 0 00-.675.394.986.986 0 01-.323.168c-.033.01-.07.008-.127.013.02-.066.024-.114.047-.15.064-.105.135-.205.205-.306.023-.033.049-.063.073-.095l-.015-.023-.201.037c-.146.04-.296.07-.437.122-.148.053-.266.023-.386-.072a3.623 3.623 0 01-.733-.786l-.093-.132zm8.592 8.963l-.147.09c-.22.134-.44.266-.659.402-.093.058-.184.12-.27.188-.085.07-.124.161-.072.272.047.1.093.2.147.294.047.08.124.138.213.147.11.01.228.012.336-.012.217-.05.372-.205.528-.357a.291.291 0 00.087-.308c-.046-.18-.079-.365-.118-.547-.011-.052-.027-.103-.045-.169zm-.257-2.409c-.12.291-.205.597-.325.91-.151.433-.294.87-.435 1.323.036-.01.054-.01.067-.018.261-.16.522-.324.785-.484.054-.033.071-.078.065-.138-.012-.13-.024-.262-.034-.393l-.068-.886c-.008-.103-.02-.206-.029-.31-.009 0-.017-.002-.026-.004zm3.081-8.13l.099.285c.08.231.159.463.24.714l.58 1.952c.187.63.372 1.262.558 1.893.114.382.235.762.343 1.146.072.257.126.519.186.799.044.206.087.413.127.64.034.106.023.226.077.325l.025-.006-.068-.362c-.038-.206-.077-.412-.113-.638-.015-.07-.029-.141-.046-.211-.095-.396-.177-.796-.29-1.187-.196-.685-.413-1.364-.618-2.046-.165-.549-.322-1.1-.488-1.648-.069-.227-.15-.45-.226-.695l-.117-.336c-.037-.107-.075-.216-.115-.322-.04-.106-.084-.21-.127-.314a7.558 7.558 0 01-.027.01zM6.225 14.304c-.063-.001-.115.014-.134.083a.35.35 0 00.41.012 4.533 4.533 0 00-.276-.095zM5.23 11.98c-.026-.027-.057-.048-.075.002-.012.032-.007.07-.01.113.082-.037.082-.037.085-.115zm.062-1.189a.135.135 0 00-.088.056.197.197 0 00-.025.11c.005.152.01.306.026.457a.751.751 0 00.066.218c.061.136.157.167.288.101.055-.027.06-.054.025-.11a4.52 4.52 0 01-.129-.211c-.015-.068-.066-.131-.033-.207.04-.09-.076-.116-.074-.19V10.874c-.003-.038-.006-.087-.056-.083zm-.017-.968a.867.867 0 00-.467.127c-.076.045-.084.07-.05.158.034.087.07.173.115.254.064.117.09.125.21.077a.657.657 0 01.336-.053c.202.022.357.136.504.264l.092.077c.007-.006.014-.013.022-.018-.019-.105-.035-.226-.149-.264-.157-.053-.324-.075-.508-.117l-.24-.005c.24-.169.452-.044.687.009-.063-.115-.153-.147-.23-.193-.082-.05-.17-.092-.25-.144-.06-.037-.12-.08-.072-.172zm10.233.325c-.23-.01-.427.08-.608.211-.034.026-.06.065-.105.117.087.026.15.046.232.065.044-.015.088-.03.13-.046.306-.114.61-.115.904.031.126.063.237.04.366-.005-.02-.031-.03-.054-.045-.071a.986.986 0 00-.448-.273c-.14-.044-.284-.024-.426-.03zM7.99 6.483a.308.308 0 00.002.133c.08.321.156.643.242.962.104.387.27.75.456 1.103.02.037.061.08.098.087a.404.404 0 00.253-.051l-.472-.84c-.23-.448-.405-.92-.579-1.394zM10.397.497c-.2-.008-.405.004-.603.034-.236.035-.47.087-.7.152-.287.08-.569.18-.852.273-.04.013-.074.038-.11.058.028.014.05.018.07.014.287-.068.58-.085.873-.09.134-.002.269.009.402.025.19.024.382.048.57.09.456.104.874.3 1.265.556.464.306.888.66 1.257 1.078.205.232.395.475.56.739.17.274.315.561.449.856.273.601.456 1.232.6 1.876.04.173.07.348.1.524.017.104.065.167.17.19.122.028.2.105.22.251-.003.102-.06.174-.129.24a1.065 1.065 0 00-.268.358.164.164 0 00.083-.039c.08-.086.162-.172.235-.265a.56.56 0 00.13-.333c.009-.05.022-.1.024-.15.007-.124-.017-.15-.143-.168-.025-.004-.049-.014-.073-.015-.082-.007-.125-.063-.137-.131-.033-.198-.004-.355.247-.408.086-.018.174-.03.26-.042.158-.023.315-.053.473-.067.14-.012.19.033.226.167.008.029.018.057.021.087.019.179-.008.225-.141.288-.027.013-.055.024-.078.042a.148.148 0 00-.051.067c-.039.144.073.382.206.445l.673.32c.023.011.05.015.075.023l.018-.026c-.015-.008-.032-.013-.044-.024a2.27 2.27 0 00-.544-.32 4.898 4.898 0 00-.173-.075.203.203 0 01-.126-.191c-.003-.085.045-.154.128-.187l.059-.025c.099-.044.118-.076.112-.187a.384.384 0 00-.008-.063c-.067-.294-.123-.59-.205-.88a9.478 9.478 0 00-.826-2.036 7.465 7.465 0 00-1.39-1.805 4.536 4.536 0 00-1.177-.824 3.656 3.656 0 00-1.016-.328 6.155 6.155 0 00-.712-.074zm6.719 5.955c.01.014.018.028.038.034l-.022-.044-.016.01zM4.103 3.917a.062.062 0 01-.03.012.455.455 0 01-.04.039c-.01.01-.02.02-.045.04l-.363.354c-.088.085-.17.178-.266.253-.284.22-.425.53-.544.855a.132.132 0 00-.007.071c.013.055.033.108.052.168l.074.026c-.017.056-.03.105-.047.152-.058.164-.118.327-.175.491-.005.015.008.036.019.077.08-.175.158-.33.225-.489.228-.544.484-1.074.819-1.561.09-.133.182-.266.283-.401.004-.006.007-.013.022-.03.001-.016.003-.032.015-.04l.008-.017zm12.976 2.408a.023.023 0 01.009.019.073.073 0 00-.006.01.188.188 0 00.007.02l.018.022c.002-.007.007-.016.005-.021-.003-.01-.012-.018-.02-.038a1.331 1.331 0 01-.013-.012zM4.199 4.48c-.003.004-.008.008-.027.014-.005.013-.011.025-.031.047a2.085 2.085 0 01-.124.167c-.048.07-.116.055-.181.041-.134-.028-.228.016-.287.143-.089.187-.187.37-.273.56-.049.108-.11.216-.118.36.081.003.154.007.228.008h.228a2.563 2.563 0 01-.079.264c-.01.052-.022.103-.033.155l.02.004c.018-.046.037-.092.067-.153.066-.142.13-.285.2-.426.02-.04.034-.1.116-.092 0 .043.004.084 0 .124-.005.045-.017.09-.028.143.141.043.086.174.115.269.102-.022.104-.195.248-.144v.205l.017.002.439-1.059c-.13 0-.246-.02-.358.033-.024.011-.058-.001-.108-.004.075-.15.139-.278.211-.417a.128.128 0 01.025-.036c0-.015-.001-.03.008-.038l.006-.02c-.005.006-.01.011-.028.017-.004.012-.009.024-.026.045a.085.085 0 01-.032.033c-.123.157-.09.164-.258.106-.079-.027-.078-.028-.047-.144.028-.046.056-.093.098-.15 0-.016-.001-.032.007-.042L4.2 4.48zm2.073-.67c-.003.006-.007.011-.027.016-.094.125-.194.246-.28.377-.155.238-.301.481-.451.723-.14.224-.345.368-.575.481-.017.008-.04.006-.079.011.012-.059.016-.109.033-.153a6.076 6.076 0 01.229-.518l-.007-.02a.138.138 0 01-.035.025c-.028.05-.055.1-.093.164-.26.424-.443.817-.442.95.024.004.048.011.073.013.177.013.188.007.26-.165.03-.07.077-.12.147-.15l.175-.07c.044-.018.085-.057.146-.032.003.05-.01.11.014.145.042.062.044.125.047.193.002.049.017.098.026.147.029-.034.039-.065.05-.097.142-.39.277-.782.428-1.17.1-.256.22-.504.33-.756.013-.03.013-.067.03-.092V3.81zm3.987-.34c0 .045.01.084.021.123.042.16.094.318.124.48.024.133.023.27.028.406 0 .033-.019.067-.032.11-.094-.058-.047-.158-.106-.215h-.125c-.015.072-.01.152-.046.2-.066.085-.155.154-.236.227-.043.038-.078.018-.103-.025l-.046-.087c-.065.035-.117.069-.172.093-.116.051-.235.095-.35.147-.085.038-.09.053-.07.147.014.075.034.148.047.223.013.072.05.109.123.124.233.05.462.115.657.265.058-.102.058-.102.168-.151.03-.014.06-.03.092-.042.08-.03.115-.017.15.06.023.048.041.098.066.158.06-.14-.042-.267.017-.416.157.18.24.39.375.567a.235.235 0 00.022-.098c.002-.124 0-.247.002-.371 0-.034.013-.067.02-.1l.032-.003c.11.155.13.354.226.52a3.036 3.036 0 00-.01-.392c-.004-.045 0-.074.05-.088.08.036.116.14.215.158-.03-.275-.423-1.137-.798-1.635-.114-.127-.2-.28-.34-.386zm-2.667.696c-.019.034-.03.05-.037.067-.061.185-.125.37-.18.556-.031.105-.087.169-.195.19-.09.019-.178.052-.268.073-.038.009-.089.015-.118-.003-.024-.016-.025-.069-.036-.106-.064.076-.082.087-.17.047-.133-.062-.262-.135-.393-.201-.048-.025-.093-.063-.17-.03-.043.12-.091.25-.137.382-.099.28-.087.242.095.453.046.048.102.03.154.023.054-.009.106-.03.16-.036.13-.013.26-.08.367-.015.204-.064.387-.122.571-.178.05-.015.089.005.114.054.022.042.034.093.082.121.038-.056-.013-.128.063-.178l.14.241-.042-1.46zm.278.358c-.096-.01-.107.01-.11.108-.002.038-.003.078.002.115.03.2.099.386.174.57.002.006.012.01.022.015l.078-.05c.052.036.081.088.153.088.205-.002.41.014.616.012.099-.001.158.042.205.12.018.03.024.077.088.066l-.08-.394c-.05-.195-.085-.395-.172-.589-.057.057-.114.068-.18.046a.72.72 0 00-.135-.028c-.22-.028-.44-.059-.66-.08zm10.254-1.727c.089.163.155.316.139.491-.016.168.026.342-.044.516-.047-.033-.088-.082-.112-.075-.117.035-.164-.057-.227-.115a4.772 4.772 0 01-.286-.29l-.104-.113a4.856 4.856 0 01-.023.019c.035.046.07.093.11.156.04.064.084.127.122.193.034.058.065.118.031.205-.082-.01-.164-.019-.246-.032-.06-.01-.101 0-.124.07-.031.098-.037.096-.15.09.02.042.036.08.057.116.041.074.03.138-.03.196-.06.06-.118.122-.178.181a.175.175 0 01-.185.046c-.222-.061-.447-.113-.67-.174-.032-.009-.063-.04-.086-.068-.03-.04-.052-.087-.08-.13-.044-.07-.09-.138-.136-.207a.18.18 0 00-.014.105c.012.127.03.253.035.38.005.1-.024.12-.121.104-.104-.017-.206-.04-.31-.058-.064-.012-.131-.028-.202.03l.081.208c.09 0 .166-.01.237.002a.819.819 0 01.458.251c.078.083.154.168.241.26l.018-.005c-.004-.006-.008-.013-.01-.04.014-.056-.062-.118.018-.178.031.03.064.057.088.09.058.078.111.159.169.257l.089.141.024-.013a2093.819 2093.819 0 01-.427-.934c.055.007.083.007.108.016.193.07.385.142.577.216.074.028.147.06.219.094.062.028.112.018.157-.033.05-.056.102-.112.154-.167.05-.051.095-.046.132.014.016.025.026.053.04.08.071.138.143.277.217.433l.159.308.025-.011c-.044-.106-.07-.218-.138-.334-.057-.182-.168-.346-.206-.545.136.034.362.326.567.732l.057.074.018-.011a1.563 1.563 0 01-.052-.127c-.046-.145-.097-.29-.136-.436-.022-.083-.036-.173.022-.26l.109.058-.026-.207.027-.016c.022.02.05.036.065.06.073.108.143.22.215.33.01.016.029.029.043.043-.036-.217-.2-.38-.229-.626l.155.112c.014-.166.012-.319.042-.465.032-.158-.023-.297-.063-.445.024.004.036.006.055.025.092.124.183.249.277.371.02.027.05.047.069.087l.04.063.019-.015a.293.293 0 01-.053-.082 27.922 27.922 0 01-.332-.49c-.221-.311-.363-.467-.485-.521zm-6.57.327c-.003.161.092.275.069.415l-.368.087c.09.139.032.237-.052.331-.05.057-.092.122-.143.178-.037.04-.046.078-.018.126l.16.275c.029.048.072.066.128.064.076-.003.152 0 .228-.001.116-.003.216.022.275.137.006.014.02.024.044.052.004-.059-.003-.098.01-.13.016-.04.04-.099.072-.108.084-.023.173-.024.26-.03.013-.001.027.018.04.029l.071.065c.019-.11-.082-.198-.024-.31l.126.04c-.026-.123-.07-.245-.071-.366 0-.123.051-.243.115-.36.107.062.16.156.234.253.183.265.36.533.494.834.165-.078.27.068.407.088-.003-.106-.133-.441-.197-.492a.142.142 0 00-.102-.028c-.06.011-.119.039-.191.063-.025-.039-.056-.078-.077-.122a3.936 3.936 0 00-.473-.783c-.076-.094-.16-.182-.228-.26l-.391.285c-.049.035-.094.03-.132-.017l-.169-.207c-.025-.03-.053-.059-.097-.108z",
					],
				],
				[],
			],
		],
	],
	NvidiaIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M10.212 8.976V7.62c.127-.01.256-.017.388-.021 3.596-.117 5.957 3.184 5.957 3.184s-2.548 3.647-5.282 3.647a3.227 3.227 0 01-1.063-.175v-4.109c1.4.174 1.681.812 2.523 2.258l1.873-1.627a4.905 4.905 0 00-3.67-1.846 6.594 6.594 0 00-.729.044m0-4.476v2.025c.13-.01.259-.019.388-.024 5.002-.174 8.261 4.226 8.261 4.226s-3.743 4.69-7.643 4.69c-.338 0-.675-.031-1.007-.092v1.25c.278.038.558.057.838.057 3.629 0 6.253-1.91 8.794-4.169.421.347 2.146 1.193 2.501 1.564-2.416 2.083-8.048 3.763-11.24 3.763-.308 0-.603-.02-.894-.048V19.5H24v-15H10.21zm0 9.756v1.068c-3.356-.616-4.287-4.21-4.287-4.21a7.173 7.173 0 014.287-2.138v1.172h-.005a3.182 3.182 0 00-2.502 1.178s.615 2.276 2.507 2.931m-5.961-3.3c1.436-1.935 3.604-3.148 5.961-3.336V6.523C5.81 6.887 2 10.723 2 10.723s2.158 6.427 8.21 7.015v-1.166C5.77 16 4.25 10.958 4.25 10.958h-.002z",
					],
				],
				[],
			],
		],
	],
	OpenRouterIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z",
					],
				],
				[],
			],
		],
	],
	SquareIcon: [
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
					["d", "M4 4H20V20H4Z"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	CompassIcon: [
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
					["d", "M10 10L10 10.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 14L14 14.01"],
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
					["d", "M8 12V16H12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 12L16 8L12 8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	PoolsideIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M6.742 22.786a11.93 11.93 0 01-5.232-4.963 11.98 11.98 0 01-1.463-6.886.975.975 0 011.943.173c-.178 2.005.246 4 1.226 5.769a9.968 9.968 0 003.526 3.685l4.586-9.405c-1.795-.598-3.29-.338-3.425-.312l-.058.012a.972.972 0 01-1.054-.576c-.24-.448-.96-1.544-1.834-1.97-.873-.426-2.218-.289-2.651-.195a.977.977 0 01-1.087-1.38C4.117.792 11.315-1.686 17.262 1.215c5.946 2.9 8.422 10.093 5.529 16.038l-.01.02c-2.903 5.94-10.095 8.414-16.039 5.514zm6.338-10.773l-4.586 9.405c4.629 1.73 9.896-.192 12.304-4.558-.338-.524-.932-1.275-1.62-1.61-.888-.434-2.19-.292-2.637-.198a.989.989 0 01-.616-.055.984.984 0 01-.49-.473c-.028-.058-.739-1.438-2.355-2.51zM5.81 6.56c.747.365 1.356.944 1.81 1.49 1.406-2.15 3.314-3.774 4.787-4.82a20.81 20.81 0 011.66-1.067A10.078 10.078 0 003.882 6.077c.617.042 1.297.174 1.929.482zm12.671-2.243c.09.624.152 1.294.182 1.965.083 1.801-.021 4.296-.844 6.722.686.018 1.484.14 2.214.495.652.318 1.198.8 1.628 1.28a10.082 10.082 0 00-3.18-10.462zm-5.394 5.46a9.522 9.522 0 012.984 2.287c1.075-3.493.606-7.402.215-8.85-1.381.584-4.75 2.62-6.84 5.618a9.515 9.515 0 013.64.944z",
					],
				],
				[],
			],
		],
	],
	PydanticIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"m23.826 17.316-4.23-5.866-6.847-9.496c-.348-.48-1.151-.48-1.497 0l-6.845 9.494-4.233 5.868a.925.925 0 0 0 .46 1.417l11.078 3.626h.002a.92.92 0 0 0 .572 0h.002l11.077-3.626c.28-.092.5-.31.59-.592a.916.916 0 0 0-.13-.825h.002ZM12.001 4.07l4.44 6.158-4.152-1.36c-.032-.01-.066-.008-.098-.016a.8.8 0 0 0-.096-.016c-.032-.004-.062-.016-.094-.016s-.062.012-.094.016a.74.74 0 0 0-.096.016c-.032.006-.066.006-.096.016L7.59 10.221l-.026.008 4.44-6.158h-.002Zm-6.273 8.7 4.834-1.583.516-.168v9.19L2.41 17.372l3.317-4.6Zm7.197 7.437V11.02l5.35 1.752 3.316 4.598-8.666 2.838Z",
					],
				],
				[],
			],
		],
	],
	QwenIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z",
					],
				],
				[],
			],
		],
	],
	RelaceIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M23 23H1V1h22v22zM2.962 15.232c1.969.3 5.028.42 7.78-.171.904-.195 1.743-.46 2.49-.803-1.395-3.4-1.675-5.766-1.264-7.378.466-1.823 1.799-2.59 2.998-2.602h.01c.688 0 2.117.177 3.081 1.35 1.003 1.22 1.216 3.152.26 5.991-.504 1.493-1.437 2.616-2.594 3.456 1.323 2.993 2.11 4.498 2.588 5.284.223.367.372.564.467.679h2.26V2.962H2.962v12.27zm11.05.827c-.912.413-1.887.711-2.857.92-2.91.626-6.059.527-8.193.234v3.825h13.471c-.527-.92-1.287-2.424-2.421-4.98zm.97-9.82c-.323.005-.87.181-1.112 1.127-.25.975-.161 2.776 1.055 5.84.705-.598 1.233-1.329 1.531-2.213.868-2.576.455-3.67.086-4.119-.406-.494-1.09-.633-1.56-.634z",
					],
				],
				[],
			],
		],
	],
	SpringIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M21.8537 1.4158a10.4504 10.4504 0 0 1-1.284 2.2471A11.9666 11.9666 0 1 0 3.8518 20.7757l.4445.3951a11.9543 11.9543 0 0 0 19.6316-8.2971c.3457-3.0126-.568-6.8649-2.0743-11.458zM5.5805 20.8745a1.0174 1.0174 0 1 1-.1482-1.4323 1.0396 1.0396 0 0 1 .1482 1.4323zm16.1991-3.5806c-2.9385 3.9263-9.2601 2.5928-13.2852 2.7904 0 0-.7161.0494-1.4323.1481 0 0 .2717-.1234.6174-.2469 2.8398-.9877 4.1732-1.1853 5.9018-2.0743 3.2349-1.6545 6.4698-5.2844 7.1118-9.0379-1.2347 3.6053-4.9881 6.7167-8.3959 7.9761-2.3459.8643-6.5685 1.7039-6.5685 1.7039l-.1729-.0988c-2.8645-1.4076-2.9632-7.6304 2.2718-9.6306 2.2966-.889 4.4696-.395 6.9637-.9877 2.6422-.6174 5.7043-2.5929 6.939-5.1857 1.3828 4.1732 3.062 10.643.0493 14.6434z",
					],
				],
				[],
			],
		],
	],
	StepFunIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M12 0C5.372 0 0 5.372 0 12s5.372 12 12 12 12-5.372 12-12S18.628 0 12 0zM8.762 19.614H4.376v-4.386h4.386v4.386zm5.423 0H9.798v-4.386h4.387v4.386zm0-5.42H9.798V9.81h4.387v4.386zm0-5.418H9.798V4.39h4.387v4.386zm5.422-.004h-4.386V4.386h4.386v4.386z",
					],
				],
				[],
			],
		],
	],
	TencentIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[["d", "M9.976 1L24 9.8l-10.587.015L10.723 23H5.489L8.18 9.8H3.244L1 5.4h8.077L9.976 1z"]],
				[],
			],
		],
	],
	UpstageIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			["path", [["d", "M19.763 0l-.373 1.297h2.594L22.354 0h-2.591z"]], []],
			["path", [["d", "M16.192 2.27l-.376 1.298h5.52l.37-1.298h-5.514z"]], []],
			["path", [["d", "M12.897 4.54l-.377 1.298h8.167l.37-1.297h-8.16z"]], []],
			["path", [["d", "M2.85 6.81l-.377 1.298h17.565l.37-1.297H2.85z"]], []],
			["path", [["d", "M3.884 9.081l-.376 1.297H19.39l.37-1.297H3.883z"]], []],
			["path", [["d", "M4.088 24l.376-1.297H1.866L1.5 24h2.588z"]], []],
			["path", [["d", "M7.662 21.73l.376-1.298H2.515L2.15 21.73h5.513z"]], []],
			["path", [["d", "M10.957 19.46l.377-1.298h-8.17l-.367 1.297h8.16z"]], []],
			["path", [["d", "M21.005 17.19l.376-1.298H3.812l-.366 1.297h17.559z"]], []],
			["path", [["d", "M19.967 14.919l.376-1.297H4.461l-.366 1.297h15.872z"]], []],
			["path", [["d", "M18.787 12.649l.376-1.298H4.26l-.366 1.298h14.893z"]], []],
		],
	],
	VeniceIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					["clip-rule", "evenodd"],
					[
						"d",
						"M8.295 16.074a4.239 4.239 0 00-1.37-.685 4.255 4.255 0 00-1.636-.138 4.27 4.27 0 00-1.566.499c-.472.26-.875.602-1.19.973-.315.37-.59.824-.773 1.336a4.432 4.432 0 00-.257 1.644c.02.564.155 1.125.375 1.621s.528.93.87 1.275c.34.346.766.657 1.256.881.49.224 1.041.36 1.598.381a4.258 4.258 0 001.62-.26 4.25 4.25 0 001.318-.786c.365-.319.703-.728.959-1.206.256-.479.43-1.027.492-1.589a4.436 4.436 0 00-.137-1.659 4.346 4.346 0 00-.675-1.39l.95-.964.691.702h.393l.475-.481v-.399l-.692-.702L12 14.11l1.004 1.018-.691.702v.399l.474.48h.393l.691-.701.95.964a4.346 4.346 0 00-.675 1.39 4.435 4.435 0 00-.137 1.66c.062.56.236 1.11.492 1.588s.594.887.96 1.206c.364.32.812.599 1.316.785a4.258 4.258 0 001.621.261 4.262 4.262 0 001.598-.38c.49-.225.916-.536 1.257-.882.341-.346.648-.779.869-1.275.22-.496.355-1.057.375-1.62a4.433 4.433 0 00-.257-1.645 4.338 4.338 0 00-.774-1.336 4.272 4.272 0 00-1.189-.973 4.27 4.27 0 00-1.566-.5 4.255 4.255 0 00-1.635.14 4.239 4.239 0 00-1.37.684l-.933-.947.69-.702v-.398l-.49-.498h-.393l-.692.701-1.004-1.018L18.15 7.87l2.132 2.163v-2.25H22.5L20.368 5.62 22.5 3.457V3.06l-.491-.498h-.393L12 12.316 2.384 2.56H1.99l-.491.498v.398L3.632 5.62 1.5 7.782h2.218v2.25L5.85 7.87l5.266 5.342-1.004 1.018-.692-.701h-.393l-.49.498v.399l.69.7-.932.948zm8.546 4.95a1.59 1.59 0 00.107 1.49c.256.43.799.73 1.294.716.494.014 1.037-.287 1.293-.716a1.59 1.59 0 00.108-1.49l.054-.06a1.53 1.53 0 001.471-.107c.424-.26.72-.81.707-1.313.014-.502-.283-1.053-.707-1.313a1.53 1.53 0 00-1.471-.107l-.054-.059a1.59 1.59 0 00-.108-1.49c-.256-.43-.799-.73-1.293-.717-.495-.013-1.038.287-1.294.716a1.59 1.59 0 00-.107 1.491l-.054.059a1.53 1.53 0 00-1.472.107c-.424.26-.72.81-.707 1.313-.013.502.283 1.053.707 1.313a1.53 1.53 0 001.472.107l.054.06zm-9.79 1.49a1.59 1.59 0 00.108-1.49l.054-.06a1.53 1.53 0 001.471-.107c.424-.26.72-.81.707-1.313.014-.502-.283-1.053-.707-1.313a1.53 1.53 0 00-1.47-.107l-.055-.059a1.59 1.59 0 00-.107-1.49c-.257-.43-.8-.73-1.294-.717-.495-.013-1.037.287-1.294.716a1.59 1.59 0 00-.107 1.491l-.054.059a1.53 1.53 0 00-1.471.107c-.424.26-.72.81-.707 1.313-.014.502.283 1.053.707 1.313a1.53 1.53 0 001.471.107l.054.06a1.59 1.59 0 00.107 1.49c.257.43.8.73 1.294.716.495.014 1.037-.287 1.294-.716z",
					],
				],
				[],
			],
			[
				"path",
				[
					["clip-rule", "evenodd"],
					[
						"d",
						"M12.274 2.56L14.8 0l1.25 1.268v4.274l-3.462 3.512h-.625L8.5 5.542V1.268L9.75 0l2.524 2.56zM9.75.898l2.212 2.243v4.12L9.75 5.018V.897zm2.837 2.243L14.799.897v4.12l-2.212 2.244V3.14z",
					],
				],
				[],
			],
		],
	],
	VercelIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[["path", [["d", "M24 22.525H0l12-21.05 12 21.05z"]], []]],
	],
	XaiIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z",
					],
				],
				[],
			],
		],
	],
	ZaiIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["fill-rule", "evenodd"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M12.105 2L9.927 4.953H.653L2.83 2h9.276zM23.254 19.048L21.078 22h-9.242l2.174-2.952h9.244zM24 2L9.264 22H0L14.736 2H24z",
					],
				],
				[],
			],
		],
	],
	TranscriptIcon: [
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
					["d", "M4 5.5h11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 10.5h16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 15.5h11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 20.5h7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	CompactLinesIcon: [
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
					["d", "M4 8h16M4 16h16"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 11.5l3 2.5 3-2.5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
					["stroke-linejoin", "round"],
				],
				[],
			],
		],
	],
	CreditCardIcon: [
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
					["d", "M7 15H8"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 9H2"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M2 18V6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M22 18V6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 4H20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M4 20H20"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	KeyIcon: [
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
					["d", "M7 17V17.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M18 3H21V6"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 8H17V10"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 12.01V12"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M16 5.00998V4.99998"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M14 7.00998V6.99998"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M12 9.00998V8.99998"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M10 11L5 11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 14L13 19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 13V19"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 21L5 21"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	PrometheusIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 24 24"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M12 0C5.373 0 0 5.372 0 12c0 6.627 5.373 12 12 12s12-5.373 12-12c0-6.628-5.373-12-12-12zm0 22.46c-1.885 0-3.414-1.26-3.414-2.814h6.828c0 1.553-1.528 2.813-3.414 2.813zm5.64-3.745H6.36v-2.046h11.28v2.046zm-.04-3.098H6.391c-.037-.043-.075-.086-.111-.13-1.155-1.401-1.427-2.133-1.69-2.879-.005-.025 1.4.287 2.395.511 0 0 .513.119 1.262.255-.72-.843-1.147-1.915-1.147-3.01 0-2.406 1.845-4.508 1.18-6.207.648.053 1.34 1.367 1.387 3.422.689-.951.977-2.69.977-3.755 0-1.103.727-2.385 1.454-2.429-.648 1.069.168 1.984.894 4.256.272.854.237 2.29.447 3.201.07-1.892.395-4.652 1.595-5.605-.529 1.2.079 2.702.494 3.424.671 1.164 1.078 2.047 1.078 3.716a4.642 4.642 0 01-1.11 2.996c.792-.149 1.34-.283 1.34-.283l2.573-.502s-.374 1.538-1.81 3.019z",
					],
				],
				[],
			],
		],
	],
	WarpStreamIcon: [
		"svg",
		[
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 618 477"],
			["width", "7777"],
			["height", "7777"],
			["class", "__icon_class__"],
			["fill", "currentColor"],
			["aria-hidden", "true"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M578.317 201.254L591.432 187.559L591.432 187.592L617.741 160.087L617.741 155.326L591.432 127.82L591.432 127.82L552.086 86.685L552.086 228.645L578.317 201.304L578.317 201.254Z",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M486.295 180.947L512.604 208.329L512.604 269.948L526.504 255.497L526.504 222.82L538.992 235.793L538.992 72.9784L512.604 45.3092L512.604 45.3912L499.488 31.6795L473.179 4.17458L473.179 311.165L486.216 297.535L486.295 180.947Z",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M407.499 217.772L433.788 190.289L433.766 288.775L433.766 352.406L446.927 338.646L446.927 302.535L446.872 176.61L460.089 162.792L460.089 0.000395572L420.605 41.2788L394.282 68.7981L394.282 393.684L407.499 379.866L407.499 217.772Z",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M328.544 300.268L354.866 272.749L354.866 434.843L368.083 421.026L368.083 259.048L381.133 245.288L381.189 82.4384L354.866 109.957L354.866 109.957L341.65 123.775L341.65 123.659L315.382 151.12L315.383 151.236L315.382 165.053L315.382 476.122L328.599 462.304L328.544 300.268Z",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M243.146 414.522L249.699 421.372L249.699 259.046L276.021 286.564L276.021 449.704L282.518 456.497L282.519 455.684L289.071 462.535L289.127 300.382L302.288 314.025L302.288 151.35L276.021 123.889L262.916 110.188L262.916 110.188L236.537 82.6108L236.537 408.427L243.146 415.335L243.146 414.522Z",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M164.267 332.028L170.819 338.994L170.819 302.071L170.875 187.641L170.875 176.609L184.036 190.369L197.142 204.07L197.142 367.211L203.805 374.177L203.806 373.364L210.248 380.215L210.248 260.85L210.248 217.888L223.464 231.589L223.465 68.9142L197.142 41.3945L184.036 27.694L157.769 0.233173L157.769 173.939L157.769 315.714L157.769 326.048L164.267 332.841L164.267 332.028Z",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M78.9113 244.324L91.9485 257.872L91.9485 221.91L118.258 194.446L118.258 285.13L131.372 298.678L131.372 298.431L131.294 180.837L144.566 166.981L144.566 4.16775L118.258 31.6727L105.143 45.3836L105.143 45.3023L78.8322 72.8894L78.8322 91.4452L78.9113 243.586L78.9113 244.324Z",
					],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M26.3101 189.814L26.3101 189.749L39.3459 203.263L39.3459 203.28L65.6564 230.538L65.6564 86.6904L39.3459 114.114L39.3459 114.196L26.3101 127.825L0.000153362 155.331L0.000152737 162.474L26.3101 189.814Z",
					],
				],
				[],
			],
		],
	],
	MagnifierCheckIcon: [
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
					["d", "M15 19H7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 3L7 3"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M3 15L3 7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 15L19 9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M19 19L19 19.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M21 21L21 21.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 17L5 17.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 17L17 17.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M5 5L5 5.01"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M9 9.01V9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M11 11.01V11"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M13 9.01V9"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M15 7.01V7"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
			[
				"path",
				[
					["d", "M17 5.01V5"],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				],
				[],
			],
		],
	],
	RadioCheckedIcon: [
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
				"rect",
				[
					["x", "9"],
					["y", "9"],
					["width", "6"],
					["height", "6"],
					["fill", "currentColor"],
				],
				[],
			],
		],
	],
	FrameworkNextjsIcon: [
		"svg",
		[
			["width", "7777"],
			["height", "7777"],
			["viewBox", "0 0 24 24"],
			["fill", "none"],
			["class", "__icon_class__"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M18.665 21.978C16.758 23.255 14.465 24 12 24 5.377 24 0 18.623 0 12S5.377 0 12 0s12 5.377 12 12c0 3.583-1.574 6.801-4.067 9.001L9.219 7.2H7.2v9.596h1.615V9.251l9.85 12.727Zm-3.332-8.533 1.6 2.061V7.2h-1.6v6.245Z",
					],
					["fill", "currentColor"],
				],
				[],
			],
		],
	],
	FrameworkNodejsIcon: [
		"svg",
		[
			["width", "7777"],
			["height", "7777"],
			["viewBox", "0 0 24 24"],
			["fill", "none"],
			["class", "__icon_class__"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M11.998,24c-0.321,0-0.641-0.084-0.922-0.247l-2.936-1.737c-0.438-0.245-0.224-0.332-0.08-0.383 0.585-0.203 0.703-0.25 1.328-0.604 0.065-0.037 0.151-0.023 0.218 0.017l2.256 1.339c0.082 0.045 0.197 0.045 0.272 0l8.795-5.076c0.082-0.047 0.134-0.141 0.134-0.238V6.921c0-0.099-0.053-0.192-0.137-0.242l-8.791-5.072c-0.081-0.047-0.189-0.047-0.271 0L3.075 6.68C2.99 6.729 2.936 6.825 2.936 6.921v10.15c0 0.097 0.054 0.189 0.139 0.235l2.409 1.392c1.307 0.654 2.108-0.116 2.108-0.89V7.787c0-0.142 0.114-0.253 0.256-0.253h1.115c0.139 0 0.255 0.112 0.255 0.253v10.021c0 1.745-0.95 2.745-2.604 2.745-0.508 0-0.909 0-2.026-0.551L2.28 18.675c-0.57-0.329-0.922-0.945-0.922-1.604V6.921c0-0.659 0.353-1.275 0.922-1.603l8.795-5.082c0.557-0.315 1.296-0.315 1.848 0l8.794 5.082c0.57 0.329 0.924 0.944 0.924 1.603v10.15c0 0.659-0.354 1.273-0.924 1.604l-8.794 5.078C12.643 23.916 12.324 24 11.998 24z M19.099 13.993c0-1.9-1.284-2.406-3.987-2.763-2.731-0.361-3.009-0.548-3.009-1.187 0-0.528 0.235-1.233 2.258-1.233 1.807 0 2.473 0.389 2.747 1.607 0.024 0.115 0.129 0.199 0.247 0.199h1.141c0.071 0 0.138-0.031 0.186-0.081 0.048-0.054 0.074-0.123 0.067-0.196-0.177-2.098-1.571-3.076-4.388-3.076-2.508 0-4.004 1.058-4.004 2.833 0 1.925 1.488 2.457 3.895 2.695 2.88 0.282 3.103 0.703 3.103 1.269 0 0.983-0.789 1.402-2.642 1.402-2.327 0-2.839-0.584-3.011-1.742-0.02-0.124-0.126-0.215-0.253-0.215h-1.137c-0.141 0-0.254 0.112-0.254 0.253 0 1.482 0.806 3.248 4.655 3.248C17.501 17.007 19.099 15.91 19.099 13.993z",
					],
					["fill", "currentColor"],
				],
				[],
			],
		],
	],
	FrameworkPythonIcon: [
		"svg",
		[
			["width", "7777"],
			["height", "7777"],
			["viewBox", "0 0 24 24"],
			["fill", "none"],
			["class", "__icon_class__"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M14.25.18l.9.2.73.26.59.3.45.32.34.34.25.34.16.33.1.3.04.26.02.2-.01.13V8.5l-.05.63-.13.55-.21.46-.26.38-.3.31-.33.25-.35.19-.35.14-.33.1-.3.07-.26.04-.21.02H8.77l-.69.05-.59.14-.5.22-.41.27-.33.32-.27.35-.2.36-.15.37-.1.35-.07.32-.04.27-.02.21v3.06H3.17l-.21-.03-.28-.07-.32-.12-.35-.18-.36-.26-.36-.36-.35-.46-.32-.59-.28-.73-.21-.88-.14-1.05-.05-1.23.06-1.22.16-1.04.24-.87.32-.71.36-.57.4-.44.42-.33.42-.24.4-.16.36-.1.32-.05.24-.01h.16l.06.01h8.16v-.83H6.18l-.01-2.75-.02-.37.05-.34.11-.31.17-.28.25-.26.31-.23.38-.2.44-.18.51-.15.58-.12.64-.1.71-.06.77-.04.84-.02 1.27.05zm-6.3 1.98l-.23.33-.08.41.08.41.23.34.33.22.41.09.41-.09.33-.22.23-.34.08-.41-.08-.41-.23-.33-.33-.22-.41-.09-.41.09zm13.09 3.95l.28.06.32.12.35.18.36.27.36.35.35.47.32.59.28.73.21.88.14 1.04.05 1.23-.06 1.23-.16 1.04-.24.86-.32.71-.36.57-.4.45-.42.33-.42.24-.4.16-.36.09-.32.05-.24.02-.16-.01h-8.22v.82h5.84l.01 2.76.02.36-.05.34-.11.31-.17.29-.25.25-.31.24-.38.2-.44.17-.51.15-.58.13-.64.09-.71.07-.77.04-.84.01-1.27-.04-1.07-.14-.9-.2-.73-.25-.59-.3-.45-.33-.34-.34-.25-.34-.16-.33-.1-.3-.04-.25-.02-.2.01-.13v-5.34l.05-.64.13-.54.21-.46.26-.38.3-.32.33-.24.35-.2.35-.14.33-.1.3-.06.26-.04.21-.02.13-.01h5.84l.69-.05.59-.14.5-.21.41-.28.33-.32.27-.35.2-.36.15-.36.1-.35.07-.32.04-.28.02-.21V6.07h2.09l.14.01zm-6.47 14.25l-.23.33-.08.41.08.41.23.33.33.23.41.08.41-.08.33-.23.23-.33.08-.41-.08-.41-.23-.33-.33-.23-.41-.08-.41.08z",
					],
					["fill", "currentColor"],
				],
				[],
			],
		],
	],
	FrameworkGoIcon: [
		"svg",
		[
			["width", "7777"],
			["height", "7777"],
			["viewBox", "0 0 24 24"],
			["fill", "none"],
			["class", "__icon_class__"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M1.811 10.231c-.047 0-.058-.023-.035-.059l.246-.315c.023-.035.081-.058.128-.058h4.172c.046 0 .058.035.035.07l-.199.303c-.023.036-.082.07-.117.07zM.047 11.306c-.047 0-.059-.023-.035-.058l.245-.316c.023-.035.082-.058.129-.058h5.328c.047 0 .07.035.058.07l-.093.28c-.012.047-.058.07-.105.07zm2.828 1.075c-.047 0-.059-.035-.035-.07l.163-.292c.023-.035.07-.07.117-.07h2.337c.047 0 .07.035.07.082l-.023.28c0 .047-.047.082-.082.082zm12.129-2.36c-.736.187-1.239.327-1.963.514-.176.046-.187.058-.34-.117-.174-.199-.303-.327-.548-.444-.737-.362-1.45-.257-2.115.175-.795.514-1.204 1.274-1.192 2.22.011.935.654 1.706 1.577 1.835.795.105 1.46-.175 1.987-.77.105-.13.198-.27.315-.434H10.47c-.245 0-.304-.152-.222-.35.152-.362.432-.97.596-1.274a.315.315 0 01.292-.187h4.253c-.023.316-.023.631-.07.947a4.983 4.983 0 01-.958 2.29c-.841 1.11-1.94 1.8-3.33 1.986-1.145.152-2.209-.07-3.143-.77-.865-.655-1.356-1.52-1.484-2.595-.152-1.274.222-2.419.993-3.424.83-1.086 1.928-1.776 3.272-2.02 1.098-.2 2.15-.07 3.096.571.62.41 1.063.97 1.356 1.648.07.105.023.164-.117.2m3.868 6.461c-1.064-.024-2.034-.328-2.852-1.029a3.665 3.665 0 01-1.262-2.255c-.21-1.32.152-2.489.947-3.529.853-1.122 1.881-1.706 3.272-1.95 1.192-.21 2.314-.095 3.33.595.923.63 1.496 1.484 1.648 2.605.198 1.578-.257 2.863-1.344 3.962-.771.783-1.718 1.273-2.805 1.495-.315.06-.63.07-.934.106zm2.78-4.72c-.011-.153-.011-.27-.034-.387-.21-1.157-1.274-1.81-2.384-1.554-1.087.245-1.788.935-2.045 2.033-.21.912.234 1.835 1.075 2.21.643.28 1.285.244 1.905-.07.923-.48 1.425-1.228 1.484-2.233z",
					],
					["fill", "currentColor"],
				],
				[],
			],
		],
	],
	FrameworkEffectIcon: [
		"svg",
		[
			["width", "7777"],
			["height", "7777"],
			["viewBox", "0 0 24 24"],
			["fill", "none"],
			["class", "__icon_class__"],
		],
		[
			[
				"path",
				[
					[
						"d",
						"M11.846.007a.8.8 0 0 0-.312.103L.454 6.346a.8.8 0 0 0-.397.855.8.8 0 0 0 .408.78L3.99 9.976 1.033 11.64a.76.76 0 0 0-.374.838c-.033.265.07.541.378.715l10.546 5.967a.8.8 0 0 0 .61.073.8.8 0 0 0 .27-.094l10.548-5.968c.31-.175.412-.454.376-.72a.76.76 0 0 0-.383-.79l-3.01-1.693 3.554-2.012a.8.8 0 0 0 .399-.836.8.8 0 0 0-.412-.753L12.455.13a.8.8 0 0 0-.28-.097.8.8 0 0 0-.227-.033m6.482 10.853 2.78 1.566-9.205 5.21-9.21-5.213 2.76-1.554 5.99 3.387a.83.83 0 0 0 .638.076.8.8 0 0 0 .285-.098zm3.572 6.03a.75.75 0 0 0-.35.098l-9.67 5.47-9.635-5.45a.75.75 0 0 0-1.01.267.717.717 0 0 0 .27.99l9.976 5.644a.75.75 0 0 0 .372.098c.079 0 .294-.026.46-.117l9.978-5.645a.716.716 0 0 0 .27-.99.75.75 0 0 0-.661-.364",
					],
					["fill", "currentColor"],
				],
				[],
			],
		],
	],
	FrameworkOpenTelemetryIcon: [
		"svg",
		[
			["width", "7777"],
			["height", "7777"],
			["viewBox", "0 0 24 24"],
			["fill", "none"],
			["class", "__icon_class__"],
		],
		[
			[
				"circle",
				[
					["cx", "12"],
					["cy", "12"],
					["r", "3"],
					["fill", "currentColor"],
				],
				[],
			],
			[
				"circle",
				[
					["cx", "6"],
					["cy", "6"],
					["r", "2"],
					["fill", "currentColor"],
				],
				[],
			],
			[
				"circle",
				[
					["cx", "18"],
					["cy", "6"],
					["r", "2"],
					["fill", "currentColor"],
				],
				[],
			],
			[
				"circle",
				[
					["cx", "6"],
					["cy", "18"],
					["r", "2"],
					["fill", "currentColor"],
				],
				[],
			],
			[
				"circle",
				[
					["cx", "18"],
					["cy", "18"],
					["r", "2"],
					["fill", "currentColor"],
				],
				[],
			],
			[
				"path",
				[
					[
						"d",
						"M12 9V7.5M12 15v1.5M9 12H7.5M15 12h1.5M9.88 9.88L8 8M14.12 9.88L16 8M9.88 14.12L8 16M14.12 14.12L16 16",
					],
					["stroke", "currentColor"],
					["stroke-width", "1.5"],
					["stroke-linecap", "round"],
				],
				[],
			],
		],
	],
} as const satisfies Record<string, IconNode>

export type IconName = keyof typeof ICON_TREES

/** `size` defaults other than 24. */
export const ICON_DEFAULT_SIZES: Partial<Record<IconName, string>> = {}

/** `MAPLE_MARK_PATH` from packages/ui/src/components/icons/maple-mark.tsx (the boot splash draws it). */
export const MAPLE_MARK_PATH =
	"M369.38 0C480.324 2.908e-08 572.686 76.542 592.669 177.775C681.438 222.749 738.763 293.878 738.765 373.942C738.763 482.538 633.316 574.71 486.96 607.449C499.978 645.591 508.455 690.397 510.789 738.765L227.967 738.764C229.399 709.074 233.146 680.725 238.834 654.436C269.538 661.732 306.949 666.785 347.396 664.859L345.194 618.741C208.102 625.268 0.005 528.243 0 373.948C2.099e-08 293.883 57.322 222.751 146.093 177.775C166.076 76.543 258.436 0.001 369.38 0ZM202.322 258.434C174.48 255.016 149.271 273.738 146.015 300.254L133.046 405.874C129.791 432.389 149.721 456.662 177.563 460.08C205.404 463.499 230.614 444.769 233.87 418.254L246.839 312.633C250.095 286.118 230.163 261.853 202.322 258.434ZM367.3 278.691C339.459 275.273 314.117 295.071 310.699 322.913L298.319 423.736C294.902 451.576 314.7 476.918 342.541 480.337C370.382 483.755 395.724 463.955 399.143 436.115L411.523 335.292C414.941 307.451 395.142 282.109 367.3 278.691Z"

/** `PIXEL_GLYPHS`: the onboarding pixel glyphs, one path per segment. */
export const PIXEL_GLYPHS = {
	"square-activity-chart": [
		"M19 21H5",
		"M19 3H5",
		"M3 19L3 5",
		"M21 19L21 5",
		"M5 12.01L5 12",
		"M9 17.01L9 17",
		"M13 11.01L13 11",
		"M15 9.01001L15 9.00001",
		"M11 15V13",
		"M7 15V14",
		"M17 7H19",
	],
	file: [
		"M8 18H16",
		"M8 14L11 14",
		"M12 4V10H8",
		"M4 20L4 10",
		"M20 20L20 4",
		"M12 2L18 2",
		"M6 22L18 22",
		"M6 8H6.01",
		"M8 6H8.01",
		"M10 4H10.01",
	],
	"chart-bar-trend-up": [
		"M10 14V20H14V14",
		"M18 10V20H22V10",
		"M2 18V20H6V18",
		"M4.01001 16L4.00001 16",
		"M12.01 12L12 12",
		"M2.01001 8L2.00001 8",
		"M4.01001 6L4.00001 6",
		"M6.01001 4L6.00001 4",
		"M8.01001 6L8.00001 6",
		"M10.01 8L10 8",
		"M12.01 6L12 6",
		"M14.01 4L14 4",
		"M20.01 8L20 8",
	],
	"triangle-warning": [
		"M4 21H20",
		"M22 17L22 19",
		"M12 17H12.01",
		"M2 17L2 19",
		"M20 13L20 15",
		"M4 13L4 15",
		"M18 9L18 11",
		"M12 13V9",
		"M6 9L6 11",
		"M16 5L16 7",
		"M8 5L8 7",
		"M10 3H14",
	],
	film: [
		"M16.5 21V16",
		"M7.5 8V3",
		"M7.5 21V16",
		"M16.5 8V3",
		"M3 8L21 8",
		"M3 16L21 16",
		"M12 21L12 3",
		"M3 5L3 19",
		"M21 5L21 19",
		"M5 3L19 3",
		"M5 21L19 21",
	],
	"nodes-3": [
		"M11 2.00001H13",
		"M11 8.00001H13",
		"M15 4L15 6",
		"M9 4L9 6",
		"M19 14H21",
		"M3.00002 14H5.00002",
		"M19 20H21",
		"M3.00002 20H5.00002",
		"M23 16L23 18",
		"M7 16L7 18",
		"M17 16L17 18",
		"M1 16L1 18",
		"M4.01003 10L4.00003 10",
		"M20 10L20.01 10",
		"M10 21L10.01 21",
		"M14 21L14.01 21",
		"M12 22L12.01 22",
		"M5.01003 8L5.00003 8",
		"M19 8L19.01 8",
	],
	"layers-3": [
		"M12.01 22L12 22",
		"M16 20L14 20",
		"M10 20L8 20",
		"M20 18L18 18",
		"M12.01 18L12 18",
		"M6 18L4 18",
		"M22.01 16L22 16",
		"M16 16L14 16",
		"M10 16L8 16",
		"M2.01001 16L2.00001 16",
		"M20 14L18 14",
		"M12.01 14L12 14",
		"M6 14L4 14",
		"M22.01 12L22 12",
		"M16 12L14 12",
		"M10 12L8 12",
		"M2.01001 12L2.00001 12",
		"M20 10L18 10",
		"M6 10L4 10",
		"M22.01 8L22 8",
		"M2.01001 8L2.00001 8",
		"M20 6L18 6",
		"M6 6L4 6",
		"M16 4L14 4",
		"M10 4L8 4",
		"M12.01 2L12 2",
	],
	bell: [
		"M9 20H9.01",
		"M15 20H15.01",
		"M16 4H16.01",
		"M8 4H8.01",
		"M11 22H13",
		"M10 2H14",
		"M21 16L21 14",
		"M3 16L3 14",
		"M18 5.99999L18 12L19 12",
		"M6 6L6 12L5 12",
		"M5 18H19",
	],
	"brackets-curly-dots": [
		"M12 16.01V16",
		"M16 16.01V16",
		"M8 16.01V16",
		"M7 3H6",
		"M17 3H18",
		"M7 21H6",
		"M17 21H18",
		"M2 12H1",
		"M22 12H23",
		"M4 10V5",
		"M20 10V5",
		"M4 19V14",
		"M20 19V14",
	],
	laptop: [
		"M3 21L21 21",
		"M3 17L6 17",
		"M18 17L21 17",
		"M8 18L16 18",
		"M23.01 19L23 19",
		"M1.01001 19L1.00001 19",
		"M3 5L3 13",
		"M21 5L21 13",
		"M19 3L5 3",
	],
	"gear-2": [
		"M12 23L12 23.0001",
		"M20 20L20 20.0001",
		"M16 20L8 20",
		"M4 20L4 20.0001",
		"M18 18H18.01",
		"M6 18H6.01",
		"M8 16L8 16.0001",
		"M10 14L10 14.0001",
		"M20 12.0001L12 12.0001",
		"M23.0051 11.9951L23.005 11.9951",
		"M1.005 11.9951L1.0049 11.9951",
		"M10 10L10 10.0001",
		"M20 16L20 8",
		"M8 8L8 8.0001",
		"M4 16L4 8",
		"M18 6H18.01",
		"M6 6H6.01",
		"M20 4L20 4.0001",
		"M16 4L8 4",
		"M4 4L4 4.0001",
		"M12 1L12 1.0001",
	],
	"users-2": [
		"M7 4H9",
		"M7 10H9",
		"M11 6L11 8",
		"M5 6L5 8",
		"M17.5 4H18.5",
		"M17.5 9H18.5",
		"M20.5 6L20.5 7",
		"M15.5 6L15.5 7",
		"M5 14H11",
		"M16 13H20",
		"M1 18V20H15V18",
		"M19 18H22V15",
		"M3 16H3.01",
		"M13 16H13.01",
	],
	rocket: [
		"M13 5H13.01",
		"M15 7H15.01",
		"M17 9H17.01",
		"M19 11H19.01",
		"M17 13H17.01",
		"M17 20H17.01",
		"M4 7H4.01",
		"M15 15H15.01",
		"M9 9H9.01",
		"M11 15H11.01",
		"M9 13H9.01",
		"M11 7H11.01",
		"M15 3H21V9",
		"M19 15V18",
		"M9 5L6 5",
		"M13 17V22H15",
		"M7 11L2 11L2 9",
		"M5 16H6",
		"M8 19L8 18",
		"M3 18V21H6",
	],
	"pen-writing": [
		"M5 15H5.01",
		"M7 13H7.01",
		"M9 11H9.01",
		"M11 9H11.01",
		"M13 7H13.01",
		"M15 5H15.01",
		"M17 3H17.01",
		"M19 5H19.01",
		"M9 19H9.01",
		"M11 17H11.01",
		"M13 21H21",
		"M13 15H13.01",
		"M15 13H15.01",
		"M17 11H17.01",
		"M19 9H19.01",
		"M21 7H21.01",
		"M3 17V21H7",
		"M15 9H15.01",
	],
} as const satisfies Record<string, ReadonlyArray<string>>
