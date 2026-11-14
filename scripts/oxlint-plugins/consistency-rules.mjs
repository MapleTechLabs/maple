/**
 * Consistency rules: the gaps the design sweeps of 2026-11 kept finding. Most drift came from four
 * places, and each rule closes one:
 *
 * - a kit component's `className` used to restyle it (`kit-class-layout-only`);
 * - a kit look rebuilt from raw classes (`no-handrolled-kit-look`);
 * - copy rules that lived only in docs/design-rules.md (`ui-copy`, `empty-copy`);
 * - values with no token yet (`surface-translucency`, `no-arbitrary-z`, `popup-radius`).
 *
 * All are ratcheted by `ui-kit-baseline.json` so they land with their burndown.
 */
import { classStrings, splitToken } from "./design-rules.mjs"
import { ratcheted } from "./ratchet.mjs"

/** Where kit components come from: the shared kit and each app's page kit. */
const KIT_SOURCE = /(?:@maple\/views\/ui\/|\/page\/kit\/|^\.\.?\/(?:\.\.\/)*kit\/)/
/**
 * Kit components that own their whole look. Wrappers that draw none (`pressable`, `truncatedText`,
 * `hstack`, `typography`) take type and colour in className by design.
 */
const LOOK_OWNERS = new Set([
	"avatarFallback",
	"badge",
	"button",
	"card",
	"emptyMessage",
	"emptyTitle",
	"eyebrow",
	"heading",
	"iconButton",
	"inlineCode",
	"linkButton",
	"meter",
	"pageTitle",
	"panel",
	"sectionHeading",
	"separator",
	"sortableHead",
	"tableHead",
	"textLink",
])

const TYPE_UTILITY =
	/^(?:text-(?:4xs|3xs|2xs|xs|sm|base|lg|[2-9]?xl)|font-(?:normal|medium|semibold|bold|mono|sans|prose)|tracking-.+|leading-.+|uppercase|lowercase|normal-case|capitalize)$/
const RADIUS_SHADOW_UTILITY = /^(?:rounded(?:-.+)?|shadow-.+)$/
/** `bg-x`, `text-x`, `border-x`, `divide-x`, `ring-x` naming a colour, not a size or side. */
const COLOR_UTILITY =
	/^(?:bg-(?!none$|clip-|origin-|repeat|no-repeat|cover$|contain$|fixed$|local$|scroll$|center$|top$|bottom$|left$|right$|linear-|radial-|conic-|\[)|text-(?!left$|right$|center$|start$|end$|justify$|wrap$|nowrap$|balance$|pretty$|ellipsis$|clip$|\[)|border-(?!\d|[trblxyse]$|[trblxyse]-\d|dashed$|dotted$|solid$|double$|none$|hidden$|collapse$|separate$|spacing)|divide-(?!x$|y$|[xy]-|dashed$|dotted$|solid$)|ring-(?!\d|inset$|offset))[a-z]/

const isVisualIdentity = (token) => {
	const { utility } = splitToken(token)
	const bare = utility.replace(/^!|!$/g, "")
	return TYPE_UTILITY.test(bare) || RADIUS_SHADOW_UTILITY.test(bare) || COLOR_UTILITY.test(bare)
}

/** String chunks of a class expression: literals, template quasis, `cn(...)` / ternary branches. */
const classChunks = (node) => {
	if (node === null || node === undefined) return []
	if (node.type === "Literal" && typeof node.value === "string") return [node.value]
	if (node.type === "TemplateLiteral") return node.quasis.map((quasi) => quasi.value.raw)
	if (node.type === "ConditionalExpression")
		return [...classChunks(node.consequent), ...classChunks(node.alternate)]
	if (node.type === "LogicalExpression") return classChunks(node.right)
	if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "cn")
		return node.arguments.flatMap(classChunks)
	return []
}

const kitClassLayoutOnly = ratcheted("kit-class-layout-only", {
	description: "A kit component's className places it; its look comes from its options.",
	message:
		"`{{token}}` restyles the kit's `{{component}}` from outside. className is for layout (margin, width, flex, grid, position). Type, colour, radius and shadow come from the component's options: add a variant or option to the kit if it lacks one.",
	collect: (_context, push) => {
		const kitNames = new Set()
		return {
			ImportDeclaration(node) {
				const source = node.source.value
				if (typeof source !== "string" || !KIT_SOURCE.test(source)) return
				for (const specifier of node.specifiers)
					if (
						specifier.type === "ImportSpecifier" &&
						LOOK_OWNERS.has(specifier.imported.name ?? specifier.local.name)
					)
						kitNames.add(specifier.local.name)
			},
			CallExpression(node) {
				const callee = node.callee
				if (callee.type !== "Identifier" || !kitNames.has(callee.name)) return
				const chunks = node.arguments.flatMap((argument) => {
					if (argument?.type === "ObjectExpression")
						return argument.properties.flatMap((property) =>
							property.type === "Property" &&
							property.key.type === "Identifier" &&
							property.key.name === "className"
								? classChunks(property.value)
								: [],
						)
					return argument?.type === "Literal" || argument?.type === "TemplateLiteral"
						? classChunks(argument)
						: []
				})
				for (const chunk of chunks)
					for (const token of chunk.split(/\s+/).filter(Boolean))
						if (isVisualIdentity(token)) push(node, { token, component: callee.name })
			},
		}
	},
})

const builderElement = (node) =>
	node.callee.type === "MemberExpression" &&
	node.callee.object.type === "Identifier" &&
	node.callee.object.name === "h" &&
	node.callee.property.type === "Identifier"
		? node.callee.property.name
		: undefined

const classTokensOf = (node) => {
	const attributes = node.arguments[0]?.type === "ArrayExpression" ? node.arguments[0].elements : []
	for (const attribute of attributes) {
		if (attribute?.type !== "CallExpression" || builderElement(attribute) !== "Class") continue
		return classChunks(attribute.arguments[0])
			.flatMap((chunk) => chunk.split(/\s+/))
			.filter(Boolean)
			.filter((token) => splitToken(token).variants.length === 0)
	}
	return []
}

/** `vstack(h, { as, className }, …)`: a stack is a raw element with a className, so it counts too. */
const stackElement = (node) => {
	if (node.callee.type !== "Identifier" || (node.callee.name !== "vstack" && node.callee.name !== "hstack"))
		return
	const options = node.arguments[1]
	if (options?.type !== "ObjectExpression") return
	const value = (key) =>
		options.properties.find(
			(property) =>
				property.type === "Property" &&
				property.key.type === "Identifier" &&
				property.key.name === key,
		)?.value
	const as = value("as")
	return {
		element: as?.type === "Literal" && typeof as.value === "string" ? as.value : "div",
		tokens: classChunks(value("className"))
			.flatMap((chunk) => chunk.split(/\s+/))
			.filter(Boolean)
			.filter((token) => splitToken(token).variants.length === 0),
	}
}

/** A raw element whose classes rebuild a kit look → the kit call that draws it. */
const KIT_LOOKS = [
	{
		kit: "`statusDot` (ui/display)",
		element: /^(span|div)$/,
		match: (t) =>
			t.some((x) => /^rounded-(full|dot)$/.test(x)) &&
			t.some((x) => /^size-(1|1\.5|2|2\.5)$/.test(x)) &&
			t.some((x) => x.startsWith("bg-")) &&
			!t.some((x) => /^(absolute|animate-)/.test(x)),
	},
	{
		kit: "`badge` (ui/display)",
		element: /^span$/,
		match: (t) =>
			t.some((x) => /^rounded(-|$)/.test(x)) &&
			t.some((x) => x.startsWith("px-")) &&
			t.some((x) => /^text-(3xs|2xs)$/.test(x)) &&
			t.some((x) => /^(bg-|border$)/.test(x)) &&
			// A label floating over a map or chart, or a dashed placeholder, is not a chip.
			!t.some((x) => x === "bg-surface-float" || x === "border-dashed"),
	},
	{
		kit: "`actionBar` (ui/action-bar)",
		element: /./,
		match: (t) =>
			t.includes("sticky") &&
			t.some((x) => /^-?bottom-/.test(x)) &&
			t.some((x) => x === "border-t" || x === "shadow-popup"),
	},
	{
		kit: "`dividedList` (ui/rule)",
		element: /./,
		match: (t) =>
			t.includes("divide-y") && t.includes("border") && t.some((x) => x.startsWith("rounded")),
	},
]

const noHandrolledKitLook = ratcheted("no-handrolled-kit-look", {
	description: "A kit look is drawn by the kit call, not rebuilt from classes.",
	message:
		"A `{{element}}` element rebuilds {{kit}} from raw classes, so it drifts from the kit (size, tone, edge). Call the kit; if it lacks a variant, add one there.",
	collect: (_context, push) => ({
		CallExpression(node) {
			const stack = stackElement(node)
			const element = builderElement(node) ?? stack?.element
			if (element === undefined) return
			const tokens = stack?.tokens ?? classTokensOf(node)
			if (tokens.length === 0) return
			const look = KIT_LOOKS.find(
				(candidate) => candidate.element.test(element) && candidate.match(tokens),
			)
			if (look !== undefined) push(node, { element, kit: look.kit })
		},
	}),
})

/** Copy that docs/design-rules.md settles. */
const COPY = [
	{ pattern: /’/, fix: "a straight apostrophe `'`" },
	{
		pattern:
			/\b(?:in the window|in window|in this (?:time )?range|(?:in|over) the selected (?:time )?(?:range|window))\b/i,
		fix: '"in this window"',
	},
	{ pattern: /^Retry$/, fix: '"Try again", the kit error-state\'s label' },
	{ pattern: /\bLoading\.\.\.$/, fix: '"Loading…"' },
	{
		pattern: /\bNo matching \w|\bNo matches found\b/,
		fix: '"No {noun} match" ("No matches" without a noun)',
	},
]

const uiCopy = ratcheted("ui-copy", {
	description: "UI copy follows docs/design-rules.md.",
	message: '"{{text}}" breaks a copy rule. Write {{fix}} (docs/design-rules.md, Copy).',
	collect: (_context, push) => {
		const check = (node, text) => {
			const rule = COPY.find(({ pattern }) => pattern.test(text))
			if (rule !== undefined) push(node, { text: text.slice(0, 60), fix: rule.fix })
		}
		return {
			Literal(node) {
				if (typeof node.value !== "string") return
				if (
					node.parent?.type === "ImportDeclaration" ||
					node.parent?.type === "ExportNamedDeclaration"
				)
					return
				check(node, node.value)
			},
			TemplateElement(node) {
				check(node, node.value.cooked ?? node.value.raw)
			},
			Property(node) {
				if (node.key.type !== "Identifier" || node.key.name !== "placeholder") return
				const chunks = classChunks(node.value)
				const last = chunks.at(-1)
				// Prose ("Search services...") only; a format hint (`sk_live_...`) keeps its dots.
				if (last !== undefined && last.endsWith("...") && /\s/.test(last))
					push(node, { text: last.slice(-40), fix: 'a closing "…" on the placeholder' })
			},
		}
	},
})

/** Kit calls and option keys that hold a one-line empty message. */
const EMPTY_CALLS = new Set(["emptyTitle", "emptyMessage", "dataTableEmpty", "tableEmpty"])
const EMPTY_KEYS = new Set(["emptyText", "emptyMessage", "emptyTitle"])
const isOneLineSentence = (text) => /[^.]\.$/.test(text.trim()) && !/[.?!]\s/.test(text.trim())

const emptyCopy = ratcheted("empty-copy", {
	description: "A one-line empty message has no trailing period.",
	message: '"{{text}}" is a one-line empty message: drop its trailing period (docs/design-rules.md, Copy).',
	collect: (_context, push) => {
		/** Whole texts: a template reads as one string, its holes as a word. */
		const strings = (node) => {
			if (node?.type === "ArrayExpression") return node.elements.flatMap(strings)
			if (node?.type === "TemplateLiteral")
				return [node.quasis.map((quasi) => quasi.value.cooked ?? "").join("x")]
			if (node?.type === "ConditionalExpression")
				return [...strings(node.consequent), ...strings(node.alternate)]
			if (node?.type === "LogicalExpression") return strings(node.right)
			return node?.type === "Literal" && typeof node.value === "string" ? [node.value] : []
		}
		// A slot whose branches include a multi-sentence text is a description: periods stay.
		const report = (node, values) => {
			if (values.some((text) => /[.?!]\s/.test(text.trim()))) return
			for (const text of values)
				if (isOneLineSentence(text)) push(node, { text: text.trim().slice(-50) })
		}
		return {
			CallExpression(node) {
				if (node.callee.type !== "Identifier" || !EMPTY_CALLS.has(node.callee.name)) return
				for (const argument of node.arguments) {
					// Text that runs into an inline control ("Couldn't load. [Try again]") is a sentence, not a one-liner.
					if (
						argument?.type === "ArrayExpression" &&
						argument.elements.some((element) => element?.type === "CallExpression")
					)
						continue
					report(node, strings(argument))
				}
			},
			Property(node) {
				if (node.key.type === "Identifier" && EMPTY_KEYS.has(node.key.name))
					report(node, strings(node.value))
			},
		}
	},
})

const tokenRatchet = (name, description, message, isBad) =>
	ratcheted(name, {
		description,
		message,
		collect: (_context, push) =>
			classStrings((node, tokens) => {
				for (const token of tokens) if (isBad(splitToken(token), token, tokens)) push(node, { token })
			}),
	})

const surfaceTranslucency = tokenRatchet(
	"surface-translucency",
	"A translucent surface is a surface token.",
	"`{{token}}` hand-picks a see-through surface. Use `bg-surface-well` (an inset well on a card), `bg-surface-float` with `backdrop-blur-sm` (a label over a chart, map or media) or `bg-scrim` (behind a dialog); a new role gets a new token in tokens.css.",
	({ utility }) => /^bg-(background|card|popover|sidebar)\/\d+$/.test(utility),
)

const noArbitraryZ = tokenRatchet(
	"no-arbitrary-z",
	"Layers come from the z scale.",
	"`{{token}}` is a hand-picked layer. Use the scale: `z-1`..`z-10` inside a surface, `z-50` dialogs and sheets, `z-55` popovers and tooltips, `z-60` toasts and nested lists.",
	({ utility }) => /^-?z-\[(?!calc\()/.test(utility),
)

const popupRadius = ratcheted("popup-radius", {
	description: "A popup takes a popup radius.",
	message:
		"A `bg-popover shadow-popup` surface without a popup radius. Tooltips are `rounded-md`, listboxes and popovers `rounded-lg`, menus `rounded-xl`, dialogs `rounded-2xl`, floating pills `rounded-full`.",
	collect: (_context, push) =>
		classStrings((node, tokens) => {
			const utilities = tokens.map((token) => splitToken(token).utility)
			if (
				utilities.includes("bg-popover") &&
				utilities.includes("shadow-popup") &&
				!utilities.some((utility) => /^rounded-(md|lg|xl|2xl|full)$/.test(utility))
			)
				push(node)
		}),
})

/** A side sheet's className, read where a dialog view is given `side: "left" | "right"`. */
/** Any width utility, whatever its variants (`w-96`, `2xl:max-w-[700px]`). */
const SHEET_WIDTH = /^!?(?:min-w|max-w|w)-.+$/

const sheetSize = ratcheted("sheet-size", {
	description: "A side sheet's width is its `size`.",
	message:
		"`{{token}}` sizes a side sheet by hand. Pass `size`: `default` (a form or filters), `detail` (a peek at one item), `wide` (a log, a review, a guide) or `full` (a trace waterfall).",
	collect: (_context, push) => ({
		ObjectExpression(node) {
			const property = (key) =>
				node.properties.find(
					(entry) =>
						entry.type === "Property" &&
						entry.key.type === "Identifier" &&
						entry.key.name === key,
				)?.value
			const side = property("side")
			if (side?.type !== "Literal" || (side.value !== "left" && side.value !== "right")) return
			// Only a dialog view's inputs (`toContent`) make a sheet; a menu's or popup's `side` is placement.
			if (property("toContent") === undefined || property("entries") !== undefined) return
			for (const chunk of classChunks(property("className")))
				for (const token of chunk.split(/\s+/).filter(Boolean))
					// A variant aimed at a descendant (`[&_[data-slot=…]]:max-w-xl`) sizes that part, not the sheet.
					if (
						SHEET_WIDTH.test(splitToken(token).utility) &&
						!splitToken(token).variants.some((v) => v.startsWith("["))
					)
						push(node, { token })
		},
	}),
})

/**
 * Every step flow shows its progress with the kit's `answerTrail`: one look for connect pages,
 * setup dialogs and onboarding. A flow that marks its own `aria-current="step"` is a second trail.
 */
const oneStepTrail = {
	meta: {
		type: "problem",
		docs: { description: "Step progress is drawn by the kit's answerTrail, never hand-rolled." },
		messages: {
			oneStepTrail:
				"A hand-rolled step trail. Use `answerTrail` from `@maple/views/ui/answer-trail` so every wizard shows progress the same way: done steps as answer chips, the current one underlined.",
		},
	},
	create(context) {
		if ((context.filename ?? context.getFilename()).endsWith("packages/views/src/ui/answer-trail.ts"))
			return {}
		const isStep = (node) => node?.type === "Literal" && node.value === "step"
		return {
			CallExpression(node) {
				const callee = node.callee
				const name =
					callee.type === "MemberExpression" && !callee.computed
						? callee.property.name
						: callee.type === "Identifier"
							? callee.name
							: null
				if (name === "AriaCurrent" && isStep(node.arguments[0]))
					context.report({ node, messageId: "oneStepTrail" })
			},
			Property(node) {
				const key =
					node.key.type === "Literal"
						? node.key.value
						: node.key.type === "Identifier"
							? node.key.name
							: null
				if ((key === "aria-current" || key === "ariaCurrent") && isStep(node.value))
					context.report({ node, messageId: "oneStepTrail" })
			},
		}
	},
}

export const consistencyRules = {
	"empty-copy": emptyCopy,
	"kit-class-layout-only": kitClassLayoutOnly,
	"no-arbitrary-z": noArbitraryZ,
	"no-handrolled-kit-look": noHandrolledKitLook,
	"one-step-trail": oneStepTrail,
	"popup-radius": popupRadius,
	"sheet-size": sheetSize,
	"surface-translucency": surfaceTranslucency,
	"ui-copy": uiCopy,
}
