/**
 * Design-system rules for the dashboard (`apps/web`) and its kit (`packages/ui`), wired into the
 * `maple` plugin. Each one turns a written rule from `docs/design-rules.md` into a check, so a
 * value that bypasses the tokens fails CI instead of review. They read class strings: every string
 * literal and template chunk, split on whitespace, each token split into variants and a utility.
 */
import { readdirSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ratcheted } from "./ratchet.mjs"

/** `dark:hover:bg-x` → `{ variants: ["dark", "hover"], utility: "bg-x" }`, ignoring colons in brackets. */
export const splitToken = (token) => {
	const parts = []
	let depth = 0
	let start = 0
	for (let i = 0; i < token.length; i++) {
		const c = token[i]
		if (c === "[" || c === "(") depth++
		else if (c === "]" || c === ")") depth--
		else if (c === ":" && depth === 0) {
			parts.push(token.slice(start, i))
			start = i + 1
		}
	}
	parts.push(token.slice(start))
	return { variants: parts.slice(0, -1), utility: parts.at(-1) }
}

/** Calls `check(node, tokens)` for every string literal and template chunk. */
export const classStrings = (check) => ({
	Literal(node) {
		if (typeof node.value === "string") check(node, node.value.split(/\s+/).filter(Boolean))
	},
	TemplateElement(node) {
		check(node, node.value.raw.split(/\s+/).filter(Boolean))
	},
})

const tokenRule = (description, message, isBad) => ({
	meta: { type: "problem", docs: { description }, messages: { bad: message } },
	create(context) {
		return classStrings((node, tokens) => {
			for (const token of tokens) {
				const parts = splitToken(token)
				if (isBad(parts, token)) context.report({ node, messageId: "bad", data: { token } })
			}
		})
	},
})

const noArbitraryRadius = tokenRule(
	"Corners come from the radius tokens.",
	"`{{token}}` is a hand-picked corner. Use a radius token (`rounded-lg`, a concentric `rounded-lg-inset`, `rounded-2xs` for hairline bars); a new need gets a new token in tokens.css.",
	({ utility }) =>
		/^rounded(-[a-z]{1,2})?-\[/.test(utility) &&
		utility !== "rounded-[inherit]" &&
		!utility.endsWith("-[inherit]"),
)

const SHADOW_TOKENS = new Set([
	"raised",
	"popup",
	"control",
	"accent-start",
	"overflow-up",
	"rule-bottom",
	"none",
])
const INSET_SHADOW_TOKENS = new Set(["highlight", "pressed", "none"])

/** A shadow utility that is not one of the shadow tokens: a size, an arbitrary value or a colour. */
const isRawShadow = (token) => {
	const utility = token.replace(/^!|!$/g, "")
	if (/^(inset-)?shadow(\/\d+)?$/.test(utility)) return true
	const inset = /^inset-shadow-(.+)$/.exec(utility)
	if (inset !== null) return !INSET_SHADOW_TOKENS.has(inset[1])
	const shadow = /^shadow-(.+)$/.exec(utility)
	return shadow !== null && !SHADOW_TOKENS.has(shadow[1])
}

const noRawShadow = ratcheted("no-raw-shadow", {
	description: "Depth comes from surfaces, the hairline and the shadow tokens.",
	message:
		"`{{token}}` is not a shadow token. Use `shadow-raised`, `shadow-popup`, `shadow-control`, `shadow-accent-start`, `shadow-overflow-up` or `shadow-rule-bottom` (inset: `inset-shadow-highlight`, `inset-shadow-pressed`). A shadow's colour is part of its token; a new depth gets a new token in tokens.css.",
	collect: (_context, push) =>
		classStrings((node, tokens) => {
			for (const token of tokens) if (isRawShadow(splitToken(token).utility)) push(node, { token })
		}),
})

const noTransitionAll = tokenRule(
	"Name the properties that move.",
	"`{{token}}` animates every property, colours included. Name what moves: `transition-[opacity,translate]`.",
	({ utility }) => utility === "transition-all",
)

const COLOR_PROPS = new Set([
	"color",
	"colors",
	"background",
	"background-color",
	"border-color",
	"outline-color",
	"box-shadow",
	"fill",
	"stroke",
	"text-decoration-color",
])

const isInteractive = ({ variants }) => variants.includes("hover") || variants.includes("active")

const instantState = {
	meta: {
		type: "problem",
		docs: { description: "Hover and press land in the frame they happen; only movement eases." },
		messages: {
			bad: "`{{token}}` eases a colour on a string with hover or press states. State is instant: drop it, and transition only properties that move (opacity, translate, scale, rotate, size).",
		},
	},
	create(context) {
		return classStrings((node, tokens) => {
			const parsed = tokens.map(splitToken)
			if (!parsed.some(isInteractive)) return
			parsed.forEach(({ variants, utility }, i) => {
				if (variants.length > 0) return
				const list = /^transition-\[([^\]]+)\]$/.exec(utility)
				const eases =
					utility === "transition" ||
					utility === "transition-colors" ||
					utility === "transition-shadow" ||
					(list !== null && list[1].split(",").some((prop) => COLOR_PROPS.has(prop)))
				if (eases) context.report({ node, messageId: "bad", data: { token: tokens[i] } })
			})
		})
	},
}

const hoverNeedsActive = {
	meta: {
		type: "problem",
		docs: { description: "Every hover state has its press twin." },
		messages: {
			bad: "`{{token}}` has no `active:` twin in the same string. A press shows what a hover shows (touch has no hover): add `{{twin}}`.",
		},
	},
	create(context) {
		return classStrings((node, tokens) => {
			const parsed = tokens.map(splitToken)
			const root = (utility) => utility.replace(/^-/, "").split("-")[0]
			const roots = new Set(
				parsed.map(({ variants, utility }) => `${variants.join(":")}|${root(utility)}`),
			)
			// A pressed state written as an arbitrary variant (`[:active,[data-pressed]]:bg-x`) counts.
			const pressedRoots = new Set(
				parsed
					.filter(({ variants }) =>
						variants.some((v) => v.startsWith("[") && v.includes(":active")),
					)
					.map(({ utility }) => root(utility)),
			)
			parsed.forEach(({ variants, utility }, i) => {
				const at = variants.indexOf("hover")
				if (at === -1) return
				const twinVariants = variants.map((v, j) => (j === at ? "active" : v))
				if (
					roots.has(`${twinVariants.join(":")}|${root(utility)}`) ||
					pressedRoots.has(root(utility))
				)
					return
				context.report({
					node,
					messageId: "bad",
					data: { token: tokens[i], twin: [...twinVariants, utility].join(":") },
				})
			})
		})
	},
}

const TONES = "primary|destructive|success|warning|info|severity-(?:trace|debug|info|warn|error|fatal)"
const TONE_ALPHA = new RegExp(
	`^-?(?:bg|border(?:-[lrtbxyse])?|ring|outline|divide|fill|stroke|from|via|to|decoration|caret|accent)-(?:${TONES})/(\\d+)$`,
)

const toneAlphaSteps = tokenRule(
	"Washes and edges in a tone use the tone's alpha steps.",
	"`{{token}}` is a hand-picked tone alpha. Use the tone's steps: `-a1` faint wash, `-a2` a toned box's fill, `-a3` its edge, `-a4` a strong edge.",
	({ utility }) => {
		const match = TONE_ALPHA.exec(utility)
		return match !== null && Number(match[1]) < 50
	},
)

const couldntCopy = {
	meta: {
		type: "problem",
		docs: { description: "Failures read “Couldn't {verb} {object}”." },
		messages: { bad: "Write failures as “Couldn't {verb} {object}”, not “Failed to …”." },
	},
	create(context) {
		const check = (node, text) => {
			if (text.startsWith("Failed to ") && !text.startsWith("Failed to fetch"))
				context.report({ node, messageId: "bad" })
		}
		return {
			Literal(node) {
				if (typeof node.value === "string") check(node, node.value)
			},
			TemplateLiteral(node) {
				check(node, node.quasis[0].value.raw)
			},
		}
	},
}

const singleTooltipDelay = {
	meta: {
		type: "problem",
		docs: { description: "Every tooltip waits the one open delay." },
		messages: {
			bad: "Tooltips share one open delay (`Tooltip.OPEN_DELAY`, 600ms) so the whole app feels the same under the pointer. Drop `openDelayMs`.",
		},
	},
	create(context) {
		return {
			CallExpression(node) {
				const callee = node.callee
				if (
					callee.type !== "MemberExpression" ||
					callee.object.type !== "Identifier" ||
					callee.object.name !== "Tooltip" ||
					callee.property.name !== "init"
				)
					return
				for (const argument of node.arguments) {
					if (argument.type !== "ObjectExpression") continue
					for (const property of argument.properties)
						if (property.type === "Property" && property.key.name === "openDelayMs")
							context.report({ node: property, messageId: "bad" })
				}
			},
		}
	},
}

const noDimmedIcon = {
	meta: {
		type: "problem",
		docs: { description: "Icons draw in a solid ink, never an opacity." },
		messages: {
			bad: "`{{token}}` fades an icon. Icons inside neutral text already draw a step under it (tokens.css, icon ink); for a quieter icon give it a quieter text colour (`text-muted-foreground`, `text-foreground-subtle`). Only a reveal (`opacity-0` → `opacity-100`) may set opacity.",
		},
	},
	create(context) {
		return {
			...classStrings((node, tokens) => {
				for (const token of tokens) {
					const { variants, utility } = splitToken(token)
					if (
						variants.some((v) => v.includes("_svg")) &&
						/^opacity-\d+$/.test(utility) &&
						!/^opacity-(0|100)$/.test(utility)
					)
						context.report({ node, messageId: "bad", data: { token } })
				}
			}),
			CallExpression(node) {
				if (node.callee.type !== "Identifier" || node.callee.name !== "icon") return
				const options = node.arguments[2]
				if (options?.type !== "ObjectExpression") return
				for (const property of options.properties) {
					if (property.type !== "Property" || property.key.name !== "className") continue
					const strings =
						property.value.type === "Literal"
							? [property.value.value]
							: property.value.type === "TemplateLiteral"
								? property.value.quasis.map((quasi) => quasi.value.raw)
								: []
					for (const text of strings) {
						if (typeof text !== "string") continue
						for (const token of text.split(/\s+/)) {
							const { variants, utility } = splitToken(token)
							if (
								variants.length === 0 &&
								/^opacity-(\d+)$/.test(utility) &&
								!/^opacity-(0|100)$/.test(utility)
							)
								context.report({ node: property, messageId: "bad", data: { token } })
						}
					}
				}
			},
		}
	},
}

/** Every `--color-*` the theme defines, read from the token stylesheets. */
const STYLES = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/ui/src/styles")
const COLOR_TOKENS = new Set(
	readdirSync(STYLES)
		.filter((file) => file.endsWith(".css"))
		.flatMap((file) => [
			...readFileSync(resolve(STYLES, file), "utf8").matchAll(/--color-([a-z0-9-]+)\s*:/g),
		])
		.map((match) => match[1]),
)
for (const keyword of ["transparent", "current", "inherit"]) COLOR_TOKENS.add(keyword)
/** First segments of the colour tokens (`severity`, `surface`, `chart`): a value starting with one is a colour. */
const COLOR_ROOTS = new Set([...COLOR_TOKENS].map((name) => name.split("-")[0]))
const COLOR_UTILITY =
	/^-?(?:bg|text|border(?:-[xytblrse])?|ring|outline|divide|fill|stroke|from|via|to|decoration|caret|accent|placeholder)-([a-z][a-z0-9-]*[a-z0-9])(?:\/[\w.[\]]+)?$/

const noUnknownColorToken = tokenRule(
	"Colour utilities name a colour token that exists.",
	"`{{token}}` names a colour token that tokens.css does not define, so it draws nothing. Use an existing token (`text-success`, `bg-surface-sunken`) or add the colour to packages/ui/src/styles/tokens.css.",
	({ utility }) => {
		const match = COLOR_UTILITY.exec(utility)
		if (match === null) return false
		const name = match[1]
		return COLOR_ROOTS.has(name.split("-")[0]) && !COLOR_TOKENS.has(name)
	},
)

const trackingTokens = tokenRule(
	"Letter spacing comes from the tracking tokens.",
	"`{{token}}` is Tailwind's stock tracking. An uppercase label is the `eyebrow` kit, or `tracking-caption` (0.08em) / `tracking-overline` (0.12em); other text keeps its natural spacing (`tracking-tight` for display type).",
	({ utility }) => /^tracking-(wide|wider|widest)$/.test(utility),
)

const fontWeightScale = tokenRule(
	"Weights come from the type scale: normal, medium, semibold.",
	"`{{token}}` is off the weight scale. Use `font-normal`, `font-medium` or `font-semibold` (the `typography` `weight` option).",
	({ utility }) => /^font-(thin|extralight|light|bold|extrabold|black|\[\d+\])$/.test(utility),
)

const noOffGridSpacing = tokenRule(
	"Spacing sits on the 2px grid.",
	"`{{token}}` is a quarter step (an odd pixel). Spacing moves in half steps (2px): round to the neighbour, or write an offset from a scale value as `calc(--spacing(n)-1px)`.",
	({ utility }) => {
		const match =
			/^-?(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|left|right|bottom|start|end)-(\d+\.\d+)$/.exec(
				utility,
			)
		return match !== null && !Number.isInteger(Number(match[1]) * 2)
	},
)

const LEGACY = new Map([
	["rounded", "`rounded-sm`"],
	["flex-grow", "`grow`"],
	["flex-shrink", "`shrink`"],
	["flex-shrink-0", "`shrink-0`"],
])
const noLegacyUtility = {
	meta: {
		type: "problem",
		docs: { description: "Tailwind 4 spellings, one per look." },
		messages: { bad: "`{{token}}` is a Tailwind 3 spelling. Write {{replacement}}." },
	},
	create(context) {
		return classStrings((node, tokens) => {
			for (const token of tokens) {
				const { utility } = splitToken(token)
				const gradient = /^bg-gradient-to-([a-z]{1,2})$/.exec(utility)
				const replacement =
					gradient !== null ? `\`bg-linear-to-${gradient[1]}\`` : LEGACY.get(utility)
				if (replacement !== undefined)
					context.report({ node, messageId: "bad", data: { token, replacement } })
			}
		})
	},
}

const STATE_VARIANT = /^(?:\[[^\]]*\]|group-|peer-|in-)?(hover|active|focus-visible|focus-within)$/
/**
 * Hover fills: a row, list item or chip takes `surface-sunken` (`surface-strong` on an already
 * sunken chip); a control (ghost button, toggle, tab, menu trigger) takes `accent`, and only the
 * kit (`allowControlHover`) draws controls. `muted` is never a hover, and neither wash takes a `/NN`.
 */
const surfaceWashes = {
	meta: {
		type: "problem",
		docs: { description: "Neutral washes and hover fills are the surface tokens." },
		messages: {
			alpha:
				"`{{token}}` hand-picks a neutral wash. Use `bg-surface-faint`, `bg-surface-sunken` or `bg-surface-strong`; they read the same on any surface.",
			hover:
				"`{{token}}` is not a hover fill. A row, list item or chip hovers `bg-surface-sunken` (`bg-surface-strong` on an already sunken chip); a control's hover belongs to its kit component (`button` ghost).",
		},
		schema: [
			{
				type: "object",
				properties: { allowControlHover: { type: "boolean" } },
				additionalProperties: false,
			},
		],
	},
	create(context) {
		const allowControlHover = context.options[0]?.allowControlHover === true
		return classStrings((node, tokens) => {
			for (const token of tokens) {
				const { variants, utility } = splitToken(token)
				if (/^bg-(muted|accent)\/\d+$/.test(utility))
					context.report({ node, messageId: "alpha", data: { token } })
				else if (
					(utility === "bg-muted" || (utility === "bg-accent" && !allowControlHover)) &&
					variants.some((v) => STATE_VARIANT.test(v) || /:(hover|active)\]$/.test(v))
				)
					context.report({ node, messageId: "hover", data: { token } })
			}
		})
	},
}

const focusRing = tokenRule(
	"Focus draws one ring: solid `ring-ring`, or the input halo.",
	"`{{token}}` hand-picks a focus ring alpha. A focus ring is solid `ring-ring` (`ring-1`/`ring-2`); an input's soft halo is `ring-[3px] ring-ring/24`.",
	({ utility }) => /^ring-ring\/(\d+)$/.test(utility) && utility !== "ring-ring/24",
)

export const designRules = {
	"couldnt-copy": couldntCopy,
	"focus-ring": focusRing,
	"font-weight-scale": fontWeightScale,
	"no-legacy-utility": noLegacyUtility,
	"no-off-grid-spacing": noOffGridSpacing,
	"no-unknown-color-token": noUnknownColorToken,
	"surface-washes": surfaceWashes,
	"tracking-tokens": trackingTokens,
	"hover-needs-active": hoverNeedsActive,
	"instant-state": instantState,
	"no-arbitrary-radius": noArbitraryRadius,
	"no-dimmed-icon": noDimmedIcon,
	"no-raw-shadow": noRawShadow,
	"no-transition-all": noTransitionAll,
	"single-tooltip-delay": singleTooltipDelay,
	"tone-alpha-steps": toneAlphaSteps,
}
