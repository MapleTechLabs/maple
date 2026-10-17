/**
 * Renders the React icons the Foldkit app uses with react-dom/server and writes their element trees
 * to `src/ui/icons.generated.ts`, so the Foldkit markup is the React output, not a hand copy.
 *
 *   bun apps/web-foldkit/scripts/generate-icons.tsx
 */
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createElement, type ComponentType } from "../../web/node_modules/react/index.js"
import { renderToStaticMarkup } from "../../web/node_modules/react-dom/server.node.js"
import * as UiIcons from "../../../packages/ui/src/components/icons/index.ts"
import { MAPLE_MARK_PATH } from "../../../packages/ui/src/components/icons/maple-mark.tsx"
import * as WebIcons from "../../web/src/components/icons/index.ts"

type Icon = ComponentType<{ size?: string; className?: string }>

/**
 * The icons the Foldkit app renders, by their `@maple/ui` name, else their apps/web name. apps/web
 * re-exports `CloudflareBrandIcon as CloudflareIcon`; here `CloudflareIcon` is @maple/ui's mono one.
 */
const NAMES = [
	"AlertWarningIcon",
	"ArrowRotateAnticlockwiseIcon",
	"ArrowRotateClockwiseIcon",
	"ArrowUpIcon",
	"AwsLambdaIcon",
	"BellIcon",
	"BoxArchiveIcon",
	"BranchForkIcon",
	"BunIcon",
	"ChartBarHorizontalIcon",
	"ChartLineIcon",
	"ChatBubbleIcon",
	"ChatBubbleSparkleIcon",
	"CheckIcon",
	"ChevronDownIcon",
	"ChevronExpandYIcon",
	"ChevronLeftIcon",
	"ChevronRightIcon",
	"CircleCheckIcon",
	"CircleInfoIcon",
	"CircleQuestionIcon",
	"CircleWarningIcon",
	"CircleXmarkIcon",
	"ClockIcon",
	"ClickhouseIcon",
	"CloudflareBrandIcon",
	"CloudflareIcon",
	"CloudflareMonoIcon",
	"CodeIcon",
	"ComputerIcon",
	"ConnectionIcon",
	"CopyIcon",
	"CubeIcon",
	"DatabaseIcon",
	"DenoIcon",
	"DiscordIcon",
	"DotsIcon",
	"EnvelopeIcon",
	"ExternalLinkIcon",
	"EyeIcon",
	"FaceRobotIcon",
	"FileIcon",
	"FilterIcon",
	"FireIcon",
	"GearIcon",
	"GlobeIcon",
	"GlobePointerIcon",
	"GoogleCloudIcon",
	"GridIcon",
	"GridSquareCirclePlusIcon",
	"HistoryIcon",
	"HouseIcon",
	"IndustryIcon",
	"KeyboardIcon",
	"KubernetesIcon",
	"LayersIcon",
	"LayoutMoveToLeftIcon",
	"LayoutMoveToRightIcon",
	"LinkIcon",
	"LoaderIcon",
	"LogoutIcon",
	"MagnifierIcon",
	"MapleMark",
	"MaximizeIcon",
	"MediaPauseIcon",
	"MessagesIcon",
	"MinimizeIcon",
	"MinusIcon",
	"MongodbIcon",
	"MoonIcon",
	"MysqlIcon",
	"NetworkNodesIcon",
	"NodejsMonoIcon",
	"OpenjdkMonoIcon",
	"PaperPlaneIcon",
	"PixelTriangleWarningIcon",
	"PlanetScaleIcon",
	"PlayRotateClockwiseIcon",
	"PlusIcon",
	"PostgresIcon",
	"PulseIcon",
	"PuzzlePieceIcon",
	"PythonIcon",
	"RailwayIcon",
	"RedisIcon",
	"RocketIcon",
	"RubyIcon",
	"RustIcon",
	"ServerIcon",
	"SlackIcon",
	"SlidersIcon",
	"SquareSparkleIcon",
	"StackPerspectiveIcon",
	"SunIcon",
	"TrashIcon",
	"UiLayersIcon",
	"UserIcon",
	"XmarkIcon",
] as const

/** Names both icon sets export with different markup: which one the Foldkit callers mean. */
const SOURCE_OF = new Map<string, "ui" | "web">([
	["CloudflareIcon", "ui"],
	["LayersIcon", "web"],
])

/** Names for an icon the other set shadows: `UiLayersIcon` is @maple/ui's `LayersIcon` (the kit gallery). */
const ALIASES = new Map<string, readonly ["ui" | "web", string]>([["UiLayersIcon", ["ui", "LayersIcon"]]])

const uiIcons = new Map<string, Icon>(Object.entries(UiIcons))
const webIcons = new Map<string, Icon>(Object.entries(WebIcons))

/** Placeholders the template fills per call: React writes `size` to width/height. */
const SIZE = "7777"
const CLASS = "__icon_class__"
const TAGS = ["svg", "path", "g", "line", "circle", "rect", "polyline", "polygon", "ellipse"] as const

type Node = readonly [
	tag: string,
	attributes: ReadonlyArray<readonly [string, string]>,
	children: ReadonlyArray<Node>,
]

const decode = (value: string) =>
	value
		.replaceAll("&quot;", '"')
		.replaceAll("&#x27;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&")

/** React's static markup is well-formed XML without text nodes, so a tag scanner is enough. */
const parse = (markup: string): Node => {
	const token = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g
	const stack: Array<{ tag: string; attributes: Array<readonly [string, string]>; children: Node[] }> = []
	let root: Node | undefined
	const attach = (node: Node) => {
		const parent = stack.at(-1)
		if (parent) parent.children.push(node)
		else root = node
	}
	for (const match of markup.matchAll(token)) {
		const [, closing, tag = "", rawAttributes = "", selfClosing] = match
		if (closing) {
			const done = stack.pop()
			if (!done) throw new Error(`unbalanced </${tag}>`)
			attach([done.tag, done.attributes, done.children])
			continue
		}
		const attributes = [...rawAttributes.matchAll(/([\w:-]+)="([^"]*)"/g)].map(
			([, name = "", value = ""]) => [name, decode(value)] as const,
		)
		if (selfClosing) attach([tag, attributes, []])
		else stack.push({ tag, attributes, children: [] })
	}
	if (!root) throw new Error("no root element")
	return root
}

const render = (component: Icon, props: { size?: string; className?: string }) => {
	const markup = renderToStaticMarkup(createElement(component, props))
	if (/ id="/.test(markup)) throw new Error(`renders an id; give the generator an id scheme first`)
	if (/>[^<]/.test(markup)) throw new Error(`renders text; extend IconNode first`)
	const tags = [...markup.matchAll(/<\/?([a-zA-Z]+)/g)].map(([, tag]) => tag)
	const unknown = tags.find((tag) => !TAGS.some((known) => known === tag))
	if (unknown !== undefined) throw new Error(`uses <${unknown}>; add it to TAGS first`)
	return markup
}

const pick = (name: string): Icon => {
	const alias = ALIASES.get(name)
	if (alias !== undefined) {
		const aliased = (alias[0] === "ui" ? uiIcons : webIcons).get(alias[1])
		if (aliased === undefined) throw new Error(`${name}: ${alias[1]} is not an icon in ${alias[0]}`)
		return aliased
	}
	const ui = uiIcons.get(name)
	const web = webIcons.get(name)
	const choice = SOURCE_OF.get(name)
	const component = choice === "web" ? web : choice === "ui" ? ui : (ui ?? web)
	if (component === undefined) throw new Error(`${name} is not an icon in @maple/ui or apps/web`)
	if (choice === undefined && ui !== undefined && web !== undefined && render(ui, {}) !== render(web, {}))
		throw new Error(`${name} differs between @maple/ui and apps/web; add it to SOURCE_OF`)
	return component
}

/** The default `size` an icon writes where the template has the size mark. */
const defaultSize = (template: Node, plain: Node): string | undefined => {
	const own = template[1].findIndex(([, value]) => value === SIZE)
	if (own !== -1) return plain[1].find(([name]) => name === template[1][own]?.[0])?.[1]
	return template[2]
		.map((child, index) => defaultSize(child, plain[2][index] ?? child))
		.find((v) => v !== undefined)
}

const entries = NAMES.map((name) => {
	const component = pick(name)
	const template = parse(render(component, { size: SIZE, className: CLASS }))
	const classes = JSON.stringify(template).match(/"class","([^"]*)"/g) ?? []
	if (classes.some((entry) => entry !== `"class","${CLASS}"`))
		throw new Error(`${name} composes its className; extend the class mark first`)
	const size = defaultSize(template, parse(render(component, {})))
	return { name, tree: JSON.stringify(template), size }
})

const sizes = entries.filter((entry) => entry.size !== undefined && entry.size !== "24")

const out = resolve(import.meta.dir, "../src/ui/icons.generated.ts")
writeFileSync(
	out,
	`// Generated by scripts/generate-icons.tsx from packages/ui and apps/web icons. Do not edit.
// Each icon is [tag, attributes, children]; "${SIZE}" marks \`size\` and "${CLASS}" the className.

export const ICON_SIZE_MARK = "${SIZE}"
export const ICON_CLASS_MARK = "${CLASS}"

export type IconTag = ${TAGS.map((tag) => JSON.stringify(tag)).join(" | ")}

export type IconNode = readonly [IconTag, ReadonlyArray<readonly [string, string]>, ReadonlyArray<IconNode>]

export const ICON_TREES = {
${entries.map((entry) => `\t${entry.name}: ${entry.tree},`).join("\n")}
} as const satisfies Record<string, IconNode>

export type IconName = keyof typeof ICON_TREES

/** \`size\` defaults other than 24. */
export const ICON_DEFAULT_SIZES: Partial<Record<IconName, string>> = {
${sizes.map((entry) => `\t${entry.name}: ${JSON.stringify(entry.size)},`).join("\n")}
}

/** \`MAPLE_MARK_PATH\` from packages/ui/src/components/icons/maple-mark.tsx (the boot splash draws it). */
export const MAPLE_MARK_PATH = ${JSON.stringify(MAPLE_MARK_PATH)}
`,
)
console.log(`wrote ${entries.length} icons to ${out}`)
