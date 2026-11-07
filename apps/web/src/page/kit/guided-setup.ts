import { REPLAY_BLOCK_CLASS } from "../../components/common/replay-privacy"
import {
	agentSetupPrompt,
	ONBOARD_SKILL_COMMAND,
	onboardSkillPrompt,
} from "../../components/ingest/onboard-skill"
import {
	type FrameworkId,
	fillSnippet,
	type SdkSnippet,
	type SnippetBlock,
	sdkSnippets,
} from "../../components/quick-start/sdk-snippets"
import { type DocsPage, docsUrl } from "../../lib/docs"
import type { Lang } from "@maple/views/lib/highlight"
import { ingestUrl } from "../../lib/services/common/ingest-url"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import * as CopyButton from "@maple/views/ui/copy-button"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon, type IconName } from "@maple/views/ui/icon"
import { inlineCode } from "@maple/views/ui/inline-code"
import { panel } from "@maple/views/ui/panel"
import type * as Tabs from "@maple/views/ui/tabs"
import * as TabsView from "@maple/views/ui/tabs-view"
import { codeBlock } from "../settings/kit/code-block"
import { Array as Arr, Option } from "effect"

// `FrameworkIconStrip`, `FrameworkPicker` and `ConnectInstructions`, with `PackageManagerCodeBlock`.

const FRAMEWORK_ICONS = {
	nodejs: "FrameworkNodejsIcon",
	nextjs: "FrameworkNextjsIcon",
	browser: "GlobeIcon",
	python: "FrameworkPythonIcon",
	go: "FrameworkGoIcon",
	java: "OpenjdkIcon",
	dotnet: "CsharpIcon",
	laravel: "LaravelIcon",
	ruby: "RubyIcon",
	rust: "RustIcon",
	deno: "DenoIcon",
	effect: "FrameworkEffectIcon",
	otel: "FrameworkOpenTelemetryIcon",
} as const satisfies { readonly [Id in FrameworkId]: IconName }

/** The guide each snippet's Instrument tab links to. */
const FRAMEWORK_DOCS = {
	nodejs: { label: "Node.js", page: "nodejsGuide" },
	nextjs: { label: "Next.js", page: "nextjsGuide" },
	browser: { label: "Browser SDK", page: "browserSdk" },
	python: { label: "Python", page: "pythonGuide" },
	go: { label: "Go", page: "goGuide" },
	java: { label: "Java", page: "javaGuide" },
	dotnet: { label: ".NET", page: "dotnetGuide" },
	laravel: { label: "Laravel", page: "laravelGuide" },
	ruby: { label: "Ruby", page: "rubyGuide" },
	rust: { label: "Rust", page: "rustGuide" },
	deno: { label: "OpenTelemetry", page: "instrumentation" },
	effect: { label: "Effect", page: "effectSdk" },
	otel: { label: "OpenTelemetry", page: "instrumentation" },
} as const satisfies { readonly [Id in FrameworkId]: InstructionsDocs }

/** The org's ingest keys as far as the viewer can read them; `null` where a key could not be read. */
export type SetupKeys = Readonly<{ privateKey: string | null; publicKey: string | null }>

export const NO_KEYS: SetupKeys = { privateKey: null, publicKey: null }

/**
 * The key a snippet carries: browser code gets the public key; server code the private one, or the
 * public one when the viewer cannot read the private key (it sends from servers too).
 */
export const keyFor = (snippet: Pick<SdkSnippet, "key">, keys: SetupKeys): string | null =>
	snippet.key === "public" ? keys.publicKey : (keys.privateKey ?? keys.publicKey)

/** One code block of the Instrument tab, filled in. */
export type SetupBlock = Readonly<{ id: "env" | "instrument"; label: string; lang: Lang; code: string }>

/** The Instrument tab's blocks for `framework`: where the key goes, then what starts sending. */
export const setupBlocks = (framework: string, keys: SetupKeys): ReadonlyArray<SetupBlock> =>
	Option.match(
		Arr.findFirst(sdkSnippets, (entry) => entry.language === framework),
		{
			onNone: () => [],
			onSome: (snippet) => {
				const key = keyFor(snippet, keys) ?? "<your-ingest-key>"
				const fill = (block: SnippetBlock, id: SetupBlock["id"]): SetupBlock => ({
					id,
					label: block.label,
					lang: block.lang,
					code: fillSnippet(block.code, ingestUrl, key),
				})
				return [
					...(snippet.env === null ? [] : [fill(snippet.env, "env")]),
					fill(snippet.code, "instrument"),
				]
			},
		},
	)

/** The key the coding-agent prompt carries: the one a server snippet gets. */
export const serverKey = (keys: SetupKeys): string | null => keyFor({ key: "private" }, keys)

const SETUP_TAB_ICONS = {
	install: "DownloadIcon",
	instrument: "CodeIcon",
	"claude-code": "ClaudeIcon",
} as const satisfies { readonly [Value in (typeof SETUP_TAB_VALUES)[number]]: IconName }

const isSetupTab = (value: string): value is (typeof SETUP_TAB_VALUES)[number] =>
	Arr.some(SETUP_TAB_VALUES, (tab) => tab === value)

const PACKAGE_MANAGERS = [
	{ id: "npm", command: "npm install" },
	{ id: "yarn", command: "yarn add" },
	{ id: "pnpm", command: "pnpm add" },
	{ id: "bun", command: "bun add" },
] as const

export const SETUP_TAB_VALUES = ["install", "instrument", "claude-code"] as const
export const PACKAGE_TAB_VALUES = Arr.map(PACKAGE_MANAGERS, (pm) => pm.id)

export const frameworkIconStrip = <M>(h: HtmlBuilder<M>): Html =>
	h.span(
		[h.Class("text-muted-foreground flex shrink-0 items-center gap-2"), h.AriaHidden(true)],
		Arr.map(Arr.take(sdkSnippets, 6), (snippet) =>
			icon(h, FRAMEWORK_ICONS[snippet.language], { size: 14 }),
		),
	)

/** `FrameworkPicker`: pill chips (`compact`) or labelled cards under "Pick your stack". */
export const frameworkPicker = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ selected: string; compact: boolean; onSelect: (framework: FrameworkId) => M }>,
): Html => {
	const { compact, selected } = options
	const chips = h.div(
		[h.Class("flex flex-wrap gap-1.5")],
		Arr.map(sdkSnippets, (snippet) => {
			const isActive = selected === snippet.language
			return h.button(
				[
					h.Key(snippet.language),
					h.Type("button"),
					h.OnClick(options.onSelect(snippet.language)),
					h.Class(
						cn(
							"flex items-center gap-1.5 border font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
							compact
								? "rounded-full px-2.5 py-1 font-mono text-2xs leading-3.5"
								: "rounded-lg px-3 py-2 text-xs gap-2",
							isActive
								? compact
									? "border-primary text-primary"
									: "border-primary bg-primary-a2 text-primary"
								: compact
									? "border-border text-muted-foreground hover:text-foreground active:text-foreground hover:border-border-strong active:border-border-strong"
									: "border-border hover:border-border-strong active:border-border-strong",
						),
					),
				],
				[icon(h, FRAMEWORK_ICONS[snippet.language], { size: compact ? 12 : 14 }), snippet.label],
			)
		}),
	)
	if (compact) return chips
	return h.div([h.Class("space-y-2")], [eyebrow(h, { variant: "label" }, ["Pick your stack"]), chips])
}

export type InstructionsDocs = Readonly<{ label: string; page: DocsPage }>

const AGENT_MARKS = [
	{ name: "ClaudeIcon", className: "text-brand-claude" },
	{ name: "OpenAiIcon", className: "text-foreground" },
	{ name: "CursorIcon", className: "text-foreground" },
] as const satisfies ReadonlyArray<Readonly<{ name: IconName; className: string }>>

const AGENT_LABELS = {
	idle: "Build with your agent",
	copied: "Prompt copied",
	error: "Could not copy",
} as const satisfies Record<CopyButton.CopyStatus, string>

/**
 * maple.dev's "Build with your agent": one prompt for Claude Code, Codex or Cursor, here with the
 * org's endpoint and key. Without a key (a member, or the key store is down) the skill uses its
 * `MAPLE_TEST` placeholder and says where to get one.
 */
export const agentPromptButton = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		apiKey: string | null
		copy: CopyButton.Model
		toCopyMessage: (message: CopyButton.Message) => M
	}>,
): Html =>
	button(
		h,
		{
			variant: "outline",
			size: "lg",
			className: "agent-prompt group/agent w-full justify-between gap-3",
			attributes: [
				h.DataAttribute("copy-state", options.copy.status),
				h.Title("Copy a setup prompt for Claude Code, Codex or Cursor"),
				h.OnClick(
					options.toCopyMessage(
						CopyButton.Message.ClickedCopy({
							text: agentSetupPrompt(ingestUrl, options.apiKey ?? ""),
						}),
					),
				),
			],
		},
		[
			h.span(
				[h.Class("flex items-center gap-3")],
				[
					h.span(
						[h.AriaHidden(true), h.Class("flex")],
						Arr.map(AGENT_MARKS, (mark, index) =>
							h.span(
								[
									h.Attribute("style", `--n:${index}`),
									h.Class(
										cn(
											"agent-prompt__mark grid size-6 place-items-center rounded-full border border-border bg-card ring-2 ring-background transition-transform duration-200 ease-out",
											index > 0 && "-ml-1.5",
											index === 1 && "group-hover/agent:translate-x-0.5",
											index === 2 && "group-hover/agent:translate-x-1",
										),
									),
								],
								[icon(h, mark.name, { size: 14, className: mark.className })],
							),
						),
					),
					// Every label stays in the grid, so the button keeps the longest one's width; the
					// current one's letters blur in (`theme.css` `.agent-prompt`).
					h.span(
						[h.Class("agent-prompt__text")],
						[
							h.span(
								[h.Class("sr-only"), h.AriaLive("polite")],
								[AGENT_LABELS[options.copy.status]],
							),
							...Arr.map(CopyButton.CopyStatus.literals, (state) =>
								h.span(
									[
										h.AriaHidden(true),
										h.Class("agent-prompt__label"),
										h.DataAttribute("label", state),
									],
									Arr.map(Array.from(AGENT_LABELS[state]), (char, index) =>
										h.span([h.Attribute("style", `--i:${index}`)], [char]),
									),
								),
							),
						],
					),
				],
			),
			CopyButton.copyIndicator(h, { status: options.copy.status, iconSize: 14 }),
		],
	)

/** The parent's state for `ConnectInstructions`: its tabs, snippet copy states and Messages. */
export type InstructionsParts<M> = Readonly<{
	/** Slot id prefix, unique per page (`ingestion`, `overview-setup`). */
	slot: string
	framework: string
	keys: SetupKeys
	setupTabs: Tabs.Model
	packageTabs: Tabs.Model
	snippetCopies: Readonly<Record<string, CopyButton.Model>>
	toSetupTabs: (message: Tabs.Message) => M
	toPackageTabs: (message: Tabs.Message) => M
	toSnippetCopy: (snippet: string, message: CopyButton.Message) => M
	/** `flush` drops the outer panel so the tabs sit directly in a parent card. */
	variant: "boxed" | "flush"
	/** The Instrument tab's guide; defaults to the framework's (a Rust stack sets the Rust one). */
	docs?: InstructionsDocs
}>

const block = <M>(
	h: HtmlBuilder<M>,
	parts: InstructionsParts<M>,
	key: string,
	code: string,
	language: string,
	className?: string,
	isPlain = false,
	lang: Lang = language,
): Html =>
	codeBlock(h, {
		code,
		language,
		lang,
		className,
		isPlain,
		copy: parts.snippetCopies[key] ?? CopyButton.init(),
		toCopyMessage: (message) => parts.toSnippetCopy(key, message),
	})

const packageManagerBlock = <M>(
	h: HtmlBuilder<M>,
	parts: InstructionsParts<M>,
	packages: ReadonlyArray<string>,
): Html =>
	h.submodel({
		slotId: `${parts.slot}-package-tabs`,
		model: parts.packageTabs,
		view: TabsView.view,
		toParentMessage: parts.toPackageTabs,
		viewInputs: {
			labels: Arr.map(PACKAGE_MANAGERS, (pm) => pm.id),
			panel: (value) => {
				return Option.match(
					Arr.findFirst(PACKAGE_MANAGERS, (entry) => entry.id === value),
					{
						onNone: () => undefined,
						onSome: (pm) => [
							block(
								h,
								parts,
								`install:${pm.id}`,
								`${pm.command} ${Arr.join(packages, " ")}`,
								"shell",
							),
						],
					},
				)
			},
		},
	})

/** `ConnectInstructions` without credentials: Install / Instrument / Claude Code tabs. */
export const connectInstructions = <M>(h: HtmlBuilder<M>, parts: InstructionsParts<M>): Html => {
	const found = Arr.findFirst(sdkSnippets, (entry) => entry.language === parts.framework)
	if (Option.isNone(found)) return h.empty
	const snippet = found.value
	const isBoxed = parts.variant === "boxed"
	const padding = isBoxed ? "p-3" : "px-4 pt-3 pb-4"
	const blocks = setupBlocks(snippet.language, parts.keys)
	const install = snippet.install
	const docs = parts.docs ?? FRAMEWORK_DOCS[snippet.language]
	const tabs = h.submodel({
		slotId: `${parts.slot}-setup-tabs`,
		model: parts.setupTabs,
		view: TabsView.view,
		toParentMessage: parts.toSetupTabs,
		viewInputs: {
			variant: "underline",
			labels: ["Install", "Instrument", "Claude Code"],
			className: "flex flex-col",
			listClassName: "h-9",
			tabClassName: "gap-2 max-sm:px-1.5",
			tabContent: (value, label) => [
				icon(h, isSetupTab(value) ? SETUP_TAB_ICONS[value] : "CodeIcon", {
					size: 14,
					className: "max-sm:hidden",
				}),
				label,
			],
			wrapList: (list) =>
				h.div(
					[
						h.Class(
							cn("flex items-center justify-between gap-3 border-b", isBoxed ? "px-3" : "px-4"),
						),
					],
					[
						// On a phone the three tabs barely fit: they scroll rather than push the mark out.
						h.div([h.Class("min-w-0 overflow-x-auto [scrollbar-width:none]")], [list]),
						h.span(
							[
								h.Role("img"),
								h.AriaLabel("OpenTelemetry"),
								h.Title("OpenTelemetry"),
								h.Class("text-muted-foreground max-sm:hidden"),
							],
							[icon(h, "FrameworkOpenTelemetryIcon", { size: 16 })],
						),
					],
				),
			panelClassName: cn("overflow-auto mt-0", padding),
			panelClassNameFor: (value) => (value === "claude-code" ? "space-y-2" : undefined),
			panel: (value) => {
				if (value === "install")
					return [
						typeof install === "string"
							? block(h, parts, "install", install, "shell")
							: packageManagerBlock(h, parts, install.packages),
					]
				if (value === "instrument")
					return [
						...Arr.map(blocks, (entry, index) =>
							block(
								h,
								parts,
								entry.id,
								entry.code,
								entry.label,
								cn(REPLAY_BLOCK_CLASS, index < blocks.length - 1 && "mb-3"),
								false,
								entry.lang,
							),
						),
						h.a(
							[
								h.Class(
									"mt-3 flex items-center justify-between gap-3 rounded-md border border-border p-3 text-xs text-muted-foreground hover:border-border-strong active:border-border-strong hover:text-foreground active:text-foreground",
								),
								h.Href(docsUrl(docs.page)),
								h.Target("_blank"),
								h.Rel("noopener"),
							],
							[
								h.span(
									[],
									[
										h.span(
											[h.Class("text-foreground font-medium")],
											[`${docs.label} guide`],
										),
										" for SDK setup, logs, metrics and sampling",
									],
								),
								icon(h, "ExternalLinkIcon", { size: 12 }),
							],
						),
					]
				return [
					h.p(
						[h.Class("text-xs text-muted-foreground")],
						[
							"Install the Maple skills, then run the prompt in Claude Code, Codex, or Cursor. The",
							" ",
							inlineCode(h, {}, ["maple-onboard"]),
							" skill walks every service in the repo, installs OpenTelemetry, wires traces / logs / metrics, and verifies the bootstrap end-to-end.",
						],
					),
					block(h, parts, "skill-command", ONBOARD_SKILL_COMMAND, "shell"),
					block(
						h,
						parts,
						"skill-prompt",
						onboardSkillPrompt(ingestUrl, serverKey(parts.keys) ?? ""),
						"prompt",
						REPLAY_BLOCK_CLASS,
						true,
					),
				]
			},
		},
	})
	return isBoxed ? panel(h, {}, [tabs]) : h.div([], [tabs])
}
