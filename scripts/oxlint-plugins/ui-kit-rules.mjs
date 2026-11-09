/**
 * Kit-first rules for the dashboard (`apps/web`) and Maple Local (`apps/local-ui`), wired into the
 * `maple` plugin. Pages compose the kit (`packages/views/src/ui`, each app's `src/page/kit`) instead
 * of rebuilding controls from raw elements or the kit's style exports; values come from tokens. See "Build from the kit" in
 * `docs/design-rules.md`.
 *
 * Every rule here is ratcheted by `ui-kit-baseline.json` (see ratchet.mjs).
 */
import { classStrings, splitToken } from "./design-rules.mjs"
import { ratcheted } from "./ratchet.mjs"

/** Raw element → the kit call that replaces it. */
const CONTROLS = {
	button: "`button` / `linkButton` (ui/button), `iconButton`, `textLink`, `cardButton`, a clickable `listRow`, `sortButton` (ui/table), or `pressable` (ui/pressable) for a target that draws its own look",
	input: "`input` / `field` (ui/field), `searchInput`, `checkbox`, `switchControl`",
	textarea: "`textarea` (ui/textarea)",
	select: "`select` (ui/select) or `nativeSelect`",
	table: "`table`, `tableRow`, `tableCell` (ui/table)",
	thead: "`tableHeader` (ui/table)",
	tbody: "`tableBody` (ui/table)",
	tr: "`tableRow` (ui/table)",
	th: "`tableHead` (ui/table)",
	td: "`tableCell` (ui/table)",
	dialog: "`formDialog`, `confirmDialog` or the `dialog` component (ui/dialog)",
	label: "`label` (ui/label) or `fieldLabel` (ui/field)",
	hr: "`separator` (ui/display)",
}

const HEADINGS = new Set(["h1", "h2", "h3", "h4"])

/** `h.button(...)`: the Foldkit builder is always `h`. */
const builderElement = (node) =>
	node.callee.type === "MemberExpression" &&
	!node.callee.computed &&
	node.callee.object.type === "Identifier" &&
	node.callee.object.name === "h" &&
	node.callee.property.type === "Identifier"
		? node.callee.property.name
		: undefined

/** The attribute array of `h.el([...], children)`, or an empty list. */
const attributesOf = (node) =>
	node.arguments[0]?.type === "ArrayExpression" ? node.arguments[0].elements : []

/** The tokens of the first `h.Class("literal")` in an element's attributes, or undefined. */
const literalClassTokens = (node) => {
	for (const attribute of attributesOf(node)) {
		if (attribute?.type !== "CallExpression" || builderElement(attribute) !== "Class") continue
		const value = attribute.arguments[0]
		if (value?.type === "Literal" && typeof value.value === "string")
			return value.value.split(/\s+/).filter(Boolean)
		if (value?.type === "TemplateLiteral" && value.expressions.length === 0)
			return value.quasis[0].value.raw.split(/\s+/).filter(Boolean)
		return undefined
	}
	return undefined
}

const hasAttribute = (node, name) =>
	attributesOf(node).some(
		(attribute) => attribute?.type === "CallExpression" && builderElement(attribute) === name,
	)

/** A chip look on a `code`: a fill, a corner or padding, which is what `inlineCode` draws. */
const isCodeChip = (tokens) =>
	tokens.some((token) => /^(bg-|rounded|p[xytrbl]?-)/.test(splitToken(token).utility))

/** A hand-drawn hairline: a 1px box filled with a border colour. */
const isHairline = (tokens) => {
	const utilities = tokens.map((token) => splitToken(token).utility)
	return (
		utilities.some((utility) => utility === "h-px" || utility === "w-px") &&
		utilities.some((utility) => /^bg-border(-subtle|-strong)?$/.test(utility))
	)
}

const noRawControl = ratcheted("no-raw-control", {
	description: "Pages build controls from the kit, not raw elements.",
	message:
		"`h.{{element}}` rebuilds a kit control. Use {{replacement}}. If the kit lacks the variant you need, add it to the kit component and use it here.",
	collect: (_context, push) => ({
		CallExpression(node) {
			const element = builderElement(node)
			if (element === undefined) return
			if (Object.hasOwn(CONTROLS, element))
				return push(node, { element, replacement: CONTROLS[element] })
			const tokens = literalClassTokens(node)
			if (tokens === undefined) return
			if (element === "code" && isCodeChip(tokens))
				push(node, {
					element,
					replacement: "`inlineCode` (ui/inline-code), with `variant` and `className`",
				})
			else if (
				(element === "ul" || element === "ol") &&
				tokens.some((t) => splitToken(t).utility.startsWith("divide-"))
			)
				push(node, {
					element,
					replacement: "`dividedList` (ui/rule) or `gridListRow` (page/kit/grid-list-row)",
				})
			else if (isHairline(tokens)) push(node, { element, replacement: "`separator` (ui/display)" })
		},
	}),
})

const isLinkLook = (tokens) =>
	tokens.some((token) => {
		const { variants, utility } = splitToken(token)
		return (
			utility === "underline" ||
			(variants.length === 0 && utility === "text-primary") ||
			(variants.includes("hover") && utility.startsWith("text-"))
		)
	})

const isRowLook = (tokens) =>
	tokens.some((token) => {
		const { variants, utility } = splitToken(token)
		return variants.includes("hover") && utility.startsWith("bg-")
	})

const noRawLink = ratcheted("no-raw-link", {
	description: "Links that draw a link or row look come from the kit.",
	message:
		"`h.a` hand-styles {{look}}. Use {{replacement}}; if none fits, add the option to the kit component.",
	collect: (_context, push) => ({
		CallExpression(node) {
			if (builderElement(node) !== "a") return
			const tokens = literalClassTokens(node)
			if (tokens === undefined) return
			if (isRowLook(tokens))
				push(node, {
					look: "a row (hover fill)",
					replacement:
						"`selectableRow` with `href` (ui/selectable-row), `laneLink` (ui/lane-link) or a `listRow` with `href`",
				})
			else if (isLinkLook(tokens))
				push(node, {
					look: "a link (underline or hover tone)",
					replacement: "`textLink` with `href` (ui/text-link) or `breadcrumbLink`",
				})
		},
	}),
})

const CLICK_ELEMENTS = new Set([
	"div",
	"span",
	"li",
	"p",
	"img",
	"svg",
	"section",
	"article",
	"header",
	"footer",
	"nav",
])

const noClickableDiv = ratcheted("no-clickable-div", {
	description: "Click targets are buttons, links or kit rows, never a div with a click handler.",
	message:
		"`h.{{element}}` with `h.OnClick` is a click target keyboards and screen readers can't reach. Use `pressable` (ui/pressable) for a target that draws its own look, or a kit control (`button`, `textLink`, a clickable `listRow` or `tableRow`).",
	collect: (_context, push) => ({
		CallExpression(node) {
			const element = builderElement(node)
			if (element !== undefined && CLICK_ELEMENTS.has(element) && hasAttribute(node, "OnClick"))
				push(node, { element })
		},
	}),
})

const noRawHeading = ratcheted("no-raw-heading", {
	description: "Headings come from the kit's heading components.",
	message:
		"`h.{{element}}` is a hand-styled heading. Use `heading` (ui/heading: display, title, section, subsection, label), `sectionHeading` (page/kit/section-heading), `pageTitle` (ui/page-layout) or `detailTitle` (page/kit/detail-header); a new heading style is a new `heading` variant.",
	collect: (_context, push) => ({
		CallExpression(node) {
			const element = builderElement(node)
			if (element !== undefined && HEADINGS.has(element)) push(node, { element })
		},
	}),
})

const noKitStylesInPages = ratcheted("no-kit-styles-in-pages", {
	description: "Pages call kit components instead of rebuilding them from their styles.",
	message:
		"`{{source}}` is a kit component's styling. Call its wrapper in packages/views/src/ui (or page/kit) instead; if the wrapper lacks an option you need, add it there.",
	collect: (_context, push) => ({
		ImportDeclaration(node) {
			const source = node.source.value
			if (typeof source === "string" && source.startsWith("@maple/ui/styles/ui/"))
				push(node, { source })
		},
	}),
})

/** What `typography`'s options draw (ui/typography): size, tone, weight, mono, numeric, truncate. */
const TYPOGRAPHY_OPTION =
	/^(?:text-(?:4xs|3xs|2xs|xs|sm|base|lg|foreground|foreground-soft|muted-foreground|foreground-subtle|foreground-faint|primary|severity-error|destructive-foreground|severity-warn|success)|font-(?:normal|medium|semibold|mono)|tabular-nums|truncate)$/
/** Type that has no option yet, and layout `typography`'s `className` takes. */
const TYPOGRAPHY_EXTRA =
	/^(?:leading-|tracking-|uppercase$|lowercase$|capitalize$|italic$|whitespace-|break-|line-clamp-|min-w-0$|shrink-0$|block$|inline-block$|select-all$)/

const preferTypography = ratcheted("prefer-typography", {
	description: "A run of text on the type scale is `typography`, not a hand-written class string.",
	message:
		'`h.{{element}}([h.Class("{{classes}}")])` is a run of text. Use `typography(h, { size, tone, weight, mono, numeric, truncate, as: "{{element}}", className }, children)` (ui/typography); a look the options lack becomes a new option.',
	collect: (_context, push) => ({
		CallExpression(node) {
			const element = builderElement(node)
			if (element !== "span" && element !== "p" && element !== "div") return
			const tokens = literalClassTokens(node)
			if (tokens === undefined || tokens.length === 0) return
			if (tokens.some((token) => splitToken(token).variants.length > 0)) return
			if (!tokens.some((token) => TYPOGRAPHY_OPTION.test(token))) return
			if (tokens.every((token) => TYPOGRAPHY_OPTION.test(token) || TYPOGRAPHY_EXTRA.test(token)))
				push(node, { element, classes: tokens.join(" ") })
		},
	}),
})

const STACK_ELEMENTS = new Set(["div", "span", "section", "header", "footer", "ul", "li", "nav"])

const preferStack = ratcheted("prefer-stack", {
	description: "A flex row or column is `hstack` / `vstack`.",
	message:
		"`h.{{element}}` with `{{display}}` is a flex {{direction}}. Use `{{stack}}(h, { gap, align, justify, wrap, shrink, grow, inline, as, className }, children)` (ui/stack); padding, borders and sizes go in `className`.",
	collect: (_context, push) => ({
		CallExpression(node) {
			const element = builderElement(node)
			if (element === undefined || !STACK_ELEMENTS.has(element)) return
			const tokens = literalClassTokens(node)
			if (tokens === undefined) return
			const parsed = tokens.map(splitToken)
			const display = parsed.find(
				({ variants, utility }) =>
					variants.length === 0 && (utility === "flex" || utility === "inline-flex"),
			)
			if (display === undefined) return
			// A responsive or toggled display (`hidden md:flex`) is layout the stack can't own.
			if (parsed.some(({ utility }) => utility === "hidden" || utility === "contents")) return
			if (
				parsed.some(
					({ variants, utility }) =>
						variants.length > 0 && /^(flex|inline-flex|block|grid|flex-(col|row))$/.test(utility),
				)
			)
				return
			if (parsed.some(({ utility }) => /^flex-(row|col)-reverse$/.test(utility))) return
			const isColumn = parsed.some(
				({ variants, utility }) => variants.length === 0 && utility === "flex-col",
			)
			push(node, {
				element,
				display: display.utility,
				direction: isColumn ? "column" : "row",
				stack: isColumn ? "vstack" : "hstack",
			})
		},
	}),
})

const RAW_COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/
/** A hand-written colour; `url(#id)` points at an SVG definition and is not one. */
const isRawColor = (text) => RAW_COLOR_PATTERN.test(text.replace(/url\(#[^)]*\)/g, ""))
const PALETTE =
	/^-?(?:bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|outline|divide|fill|stroke|from|via|to|decoration|caret|accent|placeholder)-(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}|white|black)(?:\/\S+)?$/
/** Style properties whose value is a colour (CSS and camelCase spellings). */
const COLOR_PROPERTIES = new Set([
	"color",
	"background",
	"background-color",
	"backgroundColor",
	"border-color",
	"borderColor",
	"outline-color",
	"outlineColor",
	"fill",
	"stroke",
	"stop-color",
	"stopColor",
	"caret-color",
	"text-decoration-color",
])

const propertyName = (key) =>
	key.type === "Identifier"
		? key.name
		: key.type === "Literal" && typeof key.value === "string"
			? key.value
			: undefined

const noRawColor = ratcheted("no-raw-color", {
	description: "Colours come from the colour tokens.",
	message:
		"`{{token}}` is a hand-picked colour. Use a colour token (`bg-surface-sunken`, `text-primary-foreground`, `var(--color-…)` in a style); a new colour (a vendor's brand colour too) gets a token in packages/ui/src/styles/tokens.css.",
	collect: (_context, push) => ({
		...classStrings((node, tokens) => {
			for (const token of tokens) {
				const { utility } = splitToken(token)
				const bracket = utility.indexOf("-[")
				if ((bracket !== -1 && isRawColor(utility.slice(bracket))) || PALETTE.test(utility))
					push(node, { token })
			}
		}),
		Property(node) {
			const name = propertyName(node.key)
			if (name === undefined || !COLOR_PROPERTIES.has(name)) return
			const value = node.value
			const text =
				value.type === "Literal" && typeof value.value === "string"
					? value.value
					: value.type === "TemplateLiteral"
						? value.quasis.map((quasi) => quasi.value.raw).join("")
						: undefined
			if (text !== undefined && isRawColor(text)) push(node, { token: `${name}: ${text}` })
		},
	}),
})

const noArbitraryTextSize = ratcheted("no-arbitrary-text-size", {
	description: "Type sizes, line heights and tracking come from the type scale.",
	message:
		"`{{token}}` is a hand-picked type value. Use the type scale (`text-4xs` … `text-xl`), a spacing-scale line height (`leading-4.5` is 18px) or a tracking token; a new value gets a token in tokens.css.",
	collect: (_context, push) =>
		classStrings((node, tokens) => {
			for (const token of tokens) {
				const { utility } = splitToken(token)
				if (
					/^text-\[(?:length:)?\d*\.?\d+(?:px|rem|em)\]/.test(utility) ||
					/^(?:leading|tracking)-\[(?!var\()/.test(utility)
				)
					push(node, { token })
			}
		}),
})

const noArbitrarySpacing = ratcheted("no-arbitrary-spacing", {
	description: "Padding, margins and gaps come from the spacing scale.",
	message:
		"`{{token}}` is a hand-picked space. Use the spacing scale (one step is 4px: `{{suggestion}}`); an offset from a scale value is `calc(--spacing(n)-1px)`.",
	collect: (_context, push) =>
		classStrings((node, tokens) => {
			for (const token of tokens) {
				const { utility } = splitToken(token)
				const match =
					/^(-?(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy]))-\[(\d*\.?\d+)(px|rem)\]$/.exec(
						utility,
					)
				if (match === null) continue
				const px = match[3] === "rem" ? Number(match[2]) * 16 : Number(match[2])
				push(node, { token, suggestion: `${match[1]}-${px / 4}` })
			}
		}),
})

/** Text greys and tones that must draw solid. */
const FADED_TEXT =
	/^text-(?:foreground|foreground-soft|muted-foreground|foreground-subtle|foreground-faint|primary|destructive|destructive-foreground|success|warning|info|severity-(?:trace|debug|info|warn|error|fatal))\/\d+$/

const noFadedText = ratcheted("no-faded-text", {
	description: "Text draws in solid steps, never a faded colour.",
	message:
		"`{{token}}` fades text, which reads differently on every surface. Use a solid step: `text-foreground-soft`, `text-muted-foreground`, `text-foreground-subtle`, `text-foreground-faint` (a tone keeps its full colour).",
	collect: (_context, push) =>
		classStrings((node, tokens) => {
			for (const token of tokens) if (FADED_TEXT.test(splitToken(token).utility)) push(node, { token })
		}),
})

export const uiKitRules = {
	"no-arbitrary-spacing": noArbitrarySpacing,
	"no-arbitrary-text-size": noArbitraryTextSize,
	"no-clickable-div": noClickableDiv,
	"no-faded-text": noFadedText,
	"no-kit-styles-in-pages": noKitStylesInPages,
	"no-raw-color": noRawColor,
	"no-raw-control": noRawControl,
	"no-raw-heading": noRawHeading,
	"no-raw-link": noRawLink,
	"prefer-stack": preferStack,
	"prefer-typography": preferTypography,
}
