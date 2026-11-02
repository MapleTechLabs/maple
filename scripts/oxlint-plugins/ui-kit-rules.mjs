/**
 * Kit-first rules for the dashboard (`apps/web`), wired into the `maple` plugin. Pages compose the
 * kit (`apps/web/src/ui`, `apps/web/src/page/kit`) instead of rebuilding controls from raw elements
 * or the kit's style exports; values come from tokens. See "Build from the kit" in
 * `docs/design-rules.md`.
 *
 * Every rule here is ratcheted by `ui-kit-baseline.json`: a file listed there may keep the count it
 * had when the rule landed, never more. Dropping below the count is also reported, so the baseline
 * only shrinks (`bun run lint:ui-baseline` rewrites it). `MAPLE_UI_BASELINE=off` reports everything,
 * which is how that script counts.
 */
import { readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { classStrings, splitToken } from "./design-rules.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "../..")
const BASELINE_OFF = process.env.MAPLE_UI_BASELINE === "off"
const BASELINE = BASELINE_OFF ? {} : JSON.parse(readFileSync(resolve(HERE, "ui-kit-baseline.json"), "utf8"))

const BURNDOWN_HINT =
	"This file is on the UI-kit burndown (scripts/oxlint-plugins/ui-kit-baseline.json) with {{allowed}} of these and now has {{count}}."

/**
 * `collect(context, push)` returns visitors that `push(node, data)` each violation. A file over its
 * baseline gets every violation reported; a file under it gets one report asking to lower it.
 */
const ratcheted = (name, { description, message, collect }) => ({
	meta: {
		type: "problem",
		docs: { description },
		messages: {
			bad: message,
			overBaseline: `${message} ${BURNDOWN_HINT} Fix the ones you added, or more.`,
			staleBaseline: `${BURNDOWN_HINT} Lower it: run \`bun run lint:ui-baseline\`.`,
		},
	},
	create(context) {
		const allowed = BASELINE[name]?.[relative(ROOT, context.filename)] ?? 0
		const found = []
		const visitors = collect(context, (node, data = {}) => found.push({ node, data }))
		return {
			...visitors,
			"Program:exit"(program) {
				if (found.length > allowed) {
					const messageId = allowed === 0 ? "bad" : "overBaseline"
					for (const { node, data } of found)
						context.report({ node, messageId, data: { ...data, allowed, count: found.length } })
				} else if (found.length < allowed) {
					context.report({
						node: program,
						messageId: "staleBaseline",
						data: { allowed, count: found.length },
					})
				}
			},
		}
	},
})

/** Raw element → the kit call that replaces it. */
const CONTROLS = {
	button: "`button` / `linkButton` (ui/button), `iconButton`, `cardButton`, or `sortButton` (ui/table)",
	input: "`input` / `field` (ui/field), `searchInput`, `checkbox`, `switchControl`",
	textarea: "`textarea` (ui/textarea)",
	select: "`select` (ui/select) or `nativeSelect`",
	table: "`table`, `tableRow`, `tableCell` (ui/table)",
	dialog: "`formDialog`, `confirmDialog` or the `dialog` component (ui/dialog)",
	label: "`label` (ui/label) or `fieldLabel` (ui/field)",
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

const noRawControl = ratcheted("no-raw-control", {
	description: "Pages build controls from the kit, not raw elements.",
	message:
		"`h.{{element}}` rebuilds a kit control. Use {{replacement}}. If the kit lacks the variant you need, add it to the kit component and use it here.",
	collect: (_context, push) => ({
		CallExpression(node) {
			const element = builderElement(node)
			if (element !== undefined && Object.hasOwn(CONTROLS, element))
				push(node, { element, replacement: CONTROLS[element] })
		},
	}),
})

const noRawHeading = ratcheted("no-raw-heading", {
	description: "Headings come from the kit's heading components.",
	message:
		"`h.{{element}}` is a hand-styled heading. Use `sectionHeading` (page/kit/section-heading), `pageTitle` / `pageHeader` (ui/page-layout) or `detailTitle` (page/kit/detail-header); a new heading style goes into one of those.",
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
		"`{{source}}` is a kit component's styling. Call its wrapper in apps/web/src/ui (or page/kit) instead; if the wrapper lacks an option you need, add it there.",
	collect: (_context, push) => ({
		ImportDeclaration(node) {
			const source = node.source.value
			if (typeof source === "string" && source.startsWith("@maple/ui/styles/ui/"))
				push(node, { source })
		},
	}),
})

const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/

const noRawColor = ratcheted("no-raw-color", {
	description: "Colours come from the colour tokens.",
	message:
		"`{{token}}` is a hand-picked colour. Use a colour token; a new colour (a vendor's brand colour too) gets a token in packages/ui/src/styles/tokens.css.",
	collect: (_context, push) =>
		classStrings((node, tokens) => {
			for (const token of tokens) {
				const { utility } = splitToken(token)
				const bracket = utility.indexOf("-[")
				if (bracket !== -1 && RAW_COLOR.test(utility.slice(bracket))) push(node, { token })
			}
		}),
})

const noArbitraryTextSize = ratcheted("no-arbitrary-text-size", {
	description: "Type sizes come from the type scale.",
	message:
		"`{{token}}` is a hand-picked type size. Use the type scale (`text-3xs` … `text-xl`); a new size gets a token in tokens.css.",
	collect: (_context, push) =>
		classStrings((node, tokens) => {
			for (const token of tokens) {
				if (/^text-\[(?:length:)?\d*\.?\d+(?:px|rem|em)\]$/.test(splitToken(token).utility))
					push(node, { token })
			}
		}),
})

export const uiKitRules = {
	"no-arbitrary-text-size": noArbitraryTextSize,
	"no-kit-styles-in-pages": noKitStylesInPages,
	"no-raw-color": noRawColor,
	"no-raw-control": noRawControl,
	"no-raw-heading": noRawHeading,
}
