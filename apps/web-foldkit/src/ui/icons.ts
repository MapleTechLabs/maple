import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

/** SVG attributes in React's output order (React writes props in declaration order). */
const svgAttributes = <Message>(h: HtmlBuilder<Message>, attributes: ReadonlyArray<readonly [string, string]>) =>
	attributes.map(([name, value]) => h.Attribute(name, value))

// Copied from packages/ui/src/components/icons/maple-mark.tsx (a .tsx module, so not importable here).
export const MAPLE_MARK_PATH =
	"M369.38 0C480.324 2.908e-08 572.686 76.542 592.669 177.775C681.438 222.749 738.763 293.878 738.765 373.942C738.763 482.538 633.316 574.71 486.96 607.449C499.978 645.591 508.455 690.397 510.789 738.765L227.967 738.764C229.399 709.074 233.146 680.725 238.834 654.436C269.538 661.732 306.949 666.785 347.396 664.859L345.194 618.741C208.102 625.268 0.005 528.243 0 373.948C2.099e-08 293.883 57.322 222.751 146.093 177.775C166.076 76.543 258.436 0.001 369.38 0ZM202.322 258.434C174.48 255.016 149.271 273.738 146.015 300.254L133.046 405.874C129.791 432.389 149.721 456.662 177.563 460.08C205.404 463.499 230.614 444.769 233.87 418.254L246.839 312.633C250.095 286.118 230.163 261.853 202.322 258.434ZM367.3 278.691C339.459 275.273 314.117 295.071 310.699 322.913L298.319 423.736C294.902 451.576 314.7 476.918 342.541 480.337C370.382 483.755 395.724 463.955 399.143 436.115L411.523 335.292C414.941 307.451 395.142 282.109 367.3 278.691Z"

/** `<MapleMark size aria-hidden>`: the brand glyph. */
export const mapleMark = <Message>(h: HtmlBuilder<Message>, size: number): Html =>
	h.svg(
		svgAttributes(h, [
			["xmlns", "http://www.w3.org/2000/svg"],
			["viewBox", "0 0 739 739"],
			["width", String(size)],
			["height", String(size)],
			["role", "img"],
			["aria-label", "Maple"],
			["aria-hidden", "true"],
		]),
		[
			h.path(
				svgAttributes(h, [
					["fill-rule", "evenodd"],
					["clip-rule", "evenodd"],
					["fill", "currentColor"],
					["d", MAPLE_MARK_PATH],
				]),
			),
		],
	)

// packages/ui/src/components/icons/loader.tsx
const LOADER_PATHS: ReadonlyArray<readonly [string, number]> = [
	["M12 19V22", 0.5],
	["M19.01 19L19 19", 0.63],
	["M5.01001 19L5.00001 19", 0.38],
	["M17.01 17L17 17", 0.63],
	["M7.01001 17L7.00001 17", 0.38],
	["M22.005 11.995L19.005 11.995", 0.75],
	["M5.005 11.995L2.005 11.995", 0.25],
	["M17.01 7L17 7", 0.88],
	["M7.01001 7L7.00001 7", 0.13],
	["M19.01 5L19 5", 0.88],
	["M5.01001 5L5.00001 5", 0.13],
	["M12 2V5", 1],
]

/** `<LoaderIcon>`; `attributes` are the props spread after the defaults. */
export const loaderIcon = <Message>(
	h: HtmlBuilder<Message>,
	className: string,
	attributes: ReadonlyArray<Attribute<Message>>,
): Html =>
	h.svg(
		[
			...svgAttributes(h, [
				["xmlns", "http://www.w3.org/2000/svg"],
				["viewBox", "0 0 24 24"],
				["width", "24"],
				["height", "24"],
			]),
			h.Class(className),
			h.Attribute("fill", "none"),
			...attributes,
		],
		LOADER_PATHS.map(([d, opacity]) =>
			h.path(
				svgAttributes(h, [
					["d", d],
					["opacity", String(opacity)],
					["stroke", "currentColor"],
					["stroke-width", "2"],
					["stroke-linecap", "square"],
				]),
			),
		),
	)
