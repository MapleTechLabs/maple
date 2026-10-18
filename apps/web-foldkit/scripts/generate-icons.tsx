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
// Outside the apps/web barrel (its chunk loads at startup): only the Google Cloud pages draw them.
import { CloudRunIcon } from "../../web/src/components/icons/cloud-run.tsx"
import { GooglePubSubIcon } from "../../web/src/components/icons/google-pubsub.tsx"
import { MysqlDolphinIcon } from "../../web/src/components/icons/mysql-dolphin.tsx"
import { ParenthesesDotsIcon } from "../../web/src/components/icons/parentheses-dots.tsx"
import { SqlServerIcon } from "../../web/src/components/icons/sql-server.tsx"
import * as FrameworkIcons from "../../web/src/components/quick-start/framework-icons.tsx"

type Icon = ComponentType<{ size?: string; className?: string }>

/**
 * The icons the Foldkit app renders, by their `@maple/ui` name, else their apps/web name. apps/web
 * re-exports `CloudflareBrandIcon as CloudflareIcon`; here `CloudflareIcon` is @maple/ui's mono one.
 */
const NAMES = [
	"AlertWarningIcon",
	"ArrowLeftIcon",
	"ArrowRightIcon",
	"ArrowRotateAnticlockwiseIcon",
	"ArrowRotateClockwiseIcon",
	"ArrowUpDownIcon",
	"ArrowTrendDownIcon",
	"ArrowTrendUpIcon",
	"AppleIcon",
	"AwsIcon",
	"DockerIcon",
	"FolderIcon",
	"LinuxIcon",
	"MicrochipIcon",
	"MicrosoftIcon",
	"ArrowUpIcon",
	"AwsLambdaIcon",
	"BellIcon",
	"BoxArchiveIcon",
	"BracketsCurlyIcon",
	"BranchForkIcon",
	"BunIcon",
	"ChartBarHorizontalIcon",
	"ChartBarIcon",
	"ChartBarTrendUpIcon",
	"ChartLineIcon",
	"ChatBubbleIcon",
	"ChatBubbleSparkleIcon",
	"CheckIcon",
	"ChevronDownIcon",
	"ChevronExpandYIcon",
	"ChevronLeftIcon",
	"ChevronRightIcon",
	"ChevronUpIcon",
	"CircleCheckIcon",
	"CircleInfoIcon",
	"CirclePercentageIcon",
	"CircleQuestionIcon",
	"CircleWarningIcon",
	"CircleXmarkIcon",
	"ClickhouseIcon",
	"ClockIcon",
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
	"DotsVerticalIcon",
	"DownloadIcon",
	"EnvelopeIcon",
	"ExternalLinkIcon",
	"EyeIcon",
	"FaceRobotIcon",
	"FileIcon",
	"FilterIcon",
	"FireIcon",
	"FloppyDiskIcon",
	"GearIcon",
	"GithubIcon",
	"GlobeIcon",
	"GlobePointerIcon",
	"GoogleCloudIcon",
	"GridIcon",
	"GridSquareCirclePlusIcon",
	"HazelIcon",
	"GripDotsIcon",
	"HistoryIcon",
	"HouseIcon",
	"IndustryIcon",
	"KafkaIcon",
	"KeyboardIcon",
	"KubernetesIcon",
	"LayersIcon",
	"LayoutMoveToLeftIcon",
	"LayoutMoveToRightIcon",
	"LinkIcon",
	"LoaderIcon",
	"LockIcon",
	"LogoutIcon",
	"LineHeightIcon",
	"MagnifierIcon",
	"MapleMark",
	"MaximizeIcon",
	"MediaPauseIcon",
	"MenuIcon",
	"MessagesIcon",
	"MinimizeIcon",
	"MinusIcon",
	"MongodbIcon",
	"MoonIcon",
	"MysqlIcon",
	"NatsIcon",
	"NetworkNodesIcon",
	"NodejsIcon",
	"NodejsMonoIcon",
	"OpenjdkIcon",
	"OpenjdkMonoIcon",
	"PaletteIcon",
	"PaperPlaneIcon",
	"PencilIcon",
	"PixelTriangleWarningIcon",
	"PlanetScaleIcon",
	"PlayRotateClockwiseIcon",
	"PlusIcon",
	"PostgresIcon",
	"PulseIcon",
	"PuzzlePieceIcon",
	"PythonIcon",
	"RabbitmqIcon",
	"RailwayIcon",
	"RedisIcon",
	"RocketIcon",
	"RubyIcon",
	"RustIcon",
	"ServerIcon",
	"ShieldIcon",
	"SlackIcon",
	"SlidersIcon",
	"SquareSparkleIcon",
	"SquareTerminalIcon",
	"StackPerspectiveIcon",
	"StarFilledIcon",
	"StarIcon",
	"SunIcon",
	"TextWrapIcon",
	"ThumbtackIcon",
	"TagIcon",
	"TelegramIcon",
	"TrashIcon",
	"UnorderedListIcon",
	"TruckIcon",
	"UiLayersIcon",
	"UploadIcon",
	"UserIcon",
	"XmarkIcon",
	"ArrowDownIcon",
	"AspectRatioIcon",
	"IdBadgeIcon",
	"SquareMinusIcon",
	"SquarePlusIcon",
	"SparkleIcon",
	"CloudRunIcon",
	"GooglePubSubIcon",
	"MysqlDolphinIcon",
	"ParenthesesDotsIcon",
	"SqlServerIcon",
	"SitemapIcon",
	"GkeIcon",
	"GoogleCloudMonoIcon",
	"StopwatchIcon",
	"ShieldCheckIcon",
	// agent sessions: framework marks, model vendor marks, kinds of work
	"AionLabsIcon",
	"AmazonIcon",
	"AnthropicIcon",
	"ArceeIcon",
	"BaiduIcon",
	"BoltIcon",
	"ByteDanceIcon",
	"ClaudeIcon",
	"CohereIcon",
	"CrewAiIcon",
	"DeepSeekIcon",
	"EffectIcon",
	"GeminiIcon",
	"GoogleIcon",
	"GrokIcon",
	"HaystackIcon",
	"HuggingFaceIcon",
	"IbmIcon",
	"InceptionIcon",
	"KimiIcon",
	"KwaipilotIcon",
	"LangchainIcon",
	"LiquidIcon",
	"MeituanIcon",
	"MetaIcon",
	"MiniMaxIcon",
	"MistralIcon",
	"MoonshotIcon",
	"MorphIcon",
	"NousResearchIcon",
	"NvidiaIcon",
	"OpenAiIcon",
	"OpenRouterIcon",
	"PerplexityIcon",
	"PixelSparkleIcon",
	"PoolsideIcon",
	"PydanticIcon",
	"QwenIcon",
	"RelaceIcon",
	"SpringIcon",
	"StepFunIcon",
	"TencentIcon",
	"UpstageIcon",
	"VeniceIcon",
	"VercelIcon",
	"XaiIcon",
	"ZaiIcon",
	"TranscriptIcon",
	"CompactLinesIcon",
	"CreditCardIcon",
	"KeyIcon",
	"PrometheusIcon",
	"WarpStreamIcon",
	"ArrowPathIcon",
	"CursorIcon",
	"MagnifierCheckIcon",
	"RadioCheckedIcon",
	"ArrowRightFromLineIcon",
	"FingerprintIcon",
	"MobileIcon",
	"FrameworkNextjsIcon",
	"FrameworkNodejsIcon",
	"FrameworkPythonIcon",
	"FrameworkGoIcon",
	"FrameworkEffectIcon",
	"FrameworkOpenTelemetryIcon",
] as const

const duplicates = NAMES.filter((name, index) => NAMES.indexOf(name) !== index)
if (duplicates.length > 0) throw new Error(`listed twice: ${duplicates.join(", ")}`)

/** Names both icon sets export with different markup: which one the Foldkit callers mean. */
const SOURCE_OF = new Map<string, "ui" | "web">([
	["CloudflareIcon", "ui"],
	["LayersIcon", "web"],
])

type Source = "ui" | "web" | "framework"

/**
 * Names for an icon another set shadows: `UiLayersIcon` is @maple/ui's `LayersIcon` (the kit
 * gallery); `Framework*` are the quick-start stack logos (`components/quick-start/framework-icons`).
 */
const ALIASES = new Map<string, readonly [Source, string]>([
	["UiLayersIcon", ["ui", "LayersIcon"]],
	["FrameworkNextjsIcon", ["framework", "NextjsIcon"]],
	["FrameworkNodejsIcon", ["framework", "NodejsIcon"]],
	["FrameworkPythonIcon", ["framework", "PythonIcon"]],
	["FrameworkGoIcon", ["framework", "GoIcon"]],
	["FrameworkEffectIcon", ["framework", "EffectIcon"]],
	["FrameworkOpenTelemetryIcon", ["framework", "OpenTelemetryIcon"]],
])

const uiIcons = new Map<string, Icon>(Object.entries(UiIcons))
const webIcons = new Map<string, Icon>([
	...Object.entries(WebIcons),
	["CloudRunIcon", CloudRunIcon],
	["GooglePubSubIcon", GooglePubSubIcon],
	["MysqlDolphinIcon", MysqlDolphinIcon],
	["ParenthesesDotsIcon", ParenthesesDotsIcon],
	["SqlServerIcon", SqlServerIcon],
	// `GcpServiceIcon`'s GKE glyph: the Kubernetes wheel in the text colour.
	["GkeIcon", (props) => createElement(WebIcons.KubernetesIcon, { fill: "currentColor", ...props })],
])
const frameworkIcons = new Map<string, Icon>(Object.entries(FrameworkIcons))
const setOf = (source: Source) => (source === "ui" ? uiIcons : source === "web" ? webIcons : frameworkIcons)

/** Placeholders the template fills per call: React writes `size` to width/height. */
const SIZE = "7777"
const CLASS = "__icon_class__"
/** Stands for the one `useId` an icon renders (a gradient); `icon(..., { id })` fills it per call. */
const ID = "__icon_id__"
const TAGS = [
	"svg",
	"path",
	"g",
	"line",
	"circle",
	"rect",
	"polyline",
	"polygon",
	"ellipse",
	"defs",
	"linearGradient",
	"stop",
] as const

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

/** A `useId` value becomes the id mark, wherever the markup refers to it (`url(#…)`). */
const markIds = (markup: string): string => {
	const ids = [...new Set([...markup.matchAll(/ id="([^"]*)"/g)].map(([, id = ""]) => id))]
	if (ids.length > 1) throw new Error(`renders ${ids.length} ids; the id mark covers one`)
	return ids.reduce((marked, id) => marked.replaceAll(id, ID), markup)
}

const render = (component: Icon, props: { size?: string; className?: string }) => {
	const markup = markIds(renderToStaticMarkup(createElement(component, props)))
	if (/>[^<]/.test(markup)) throw new Error(`renders text; extend IconNode first`)
	const tags = [...markup.matchAll(/<\/?([a-zA-Z]+)/g)].map(([, tag]) => tag)
	const unknown = tags.find((tag) => !TAGS.some((known) => known === tag))
	if (unknown !== undefined) throw new Error(`uses <${unknown}>; add it to TAGS first`)
	return markup
}

const pick = (name: string): Icon => {
	const alias = ALIASES.get(name)
	if (alias !== undefined) {
		const aliased = setOf(alias[0]).get(alias[1])
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
// Each icon is [tag, attributes, children]; "${SIZE}" marks \`size\`, "${CLASS}" the className
// and "${ID}" an icon's own \`useId\`.

export const ICON_SIZE_MARK = "${SIZE}"
export const ICON_CLASS_MARK = "${CLASS}"
export const ICON_ID_MARK = "${ID}"

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
