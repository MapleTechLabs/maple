import { REPLAY_BLOCK_CLASS } from "../../components/common/replay-privacy"
import {
	agentSetupPrompt,
	ONBOARD_SKILL_COMMAND,
	onboardSkillPrompt,
} from "../../components/ingest/onboard-skill"
import { type FrameworkId, sdkSnippets } from "../../components/quick-start/sdk-snippets"
import { type DocsPage, docsUrl } from "../../lib/docs"
import { ingestUrl } from "../../lib/services/common/ingest-url"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import * as CopyButton from "../../ui/copy-button"
import { eyebrow } from "../../ui/eyebrow"
import { icon, type IconName } from "../../ui/icon"
import { inlineCode } from "../../ui/inline-code"
import { panel } from "../../ui/panel"
import type * as Tabs from "../../ui/tabs"
import * as TabsView from "../../ui/tabs-view"
import { codeBlock } from "../settings/kit/code-block"

// `FrameworkIconStrip`, `FrameworkPicker` and `ConnectInstructions`, with `PackageManagerCodeBlock`.

const FRAMEWORK_ICONS = {
	nextjs: "FrameworkNextjsIcon",
	nodejs: "FrameworkNodejsIcon",
	python: "FrameworkPythonIcon",
	go: "FrameworkGoIcon",
	effect: "FrameworkEffectIcon",
	otel: "FrameworkOpenTelemetryIcon",
} as const satisfies { readonly [Id in FrameworkId]: IconName }

/** The guide each snippet's Instrument tab links to. */
const FRAMEWORK_DOCS = {
	nextjs: { label: "Next.js", page: "nextjsGuide" },
	nodejs: { label: "Node.js", page: "nodejsGuide" },
	python: { label: "Python", page: "pythonGuide" },
	go: { label: "Go", page: "goGuide" },
	effect: { label: "Effect", page: "effectSdk" },
	otel: { label: "OpenTelemetry", page: "instrumentation" },
} as const satisfies { readonly [Id in FrameworkId]: InstructionsDocs }

const SETUP_TAB_ICONS = {
	install: "DownloadIcon",
	instrument: "CodeIcon",
	"claude-code": "ClaudeIcon",
} as const satisfies { readonly [Value in (typeof SETUP_TAB_VALUES)[number]]: IconName }

const isSetupTab = (value: string): value is (typeof SETUP_TAB_VALUES)[number] =>
	SETUP_TAB_VALUES.some((tab) => tab === value)

const PACKAGE_MANAGERS = [
	{ id: "npm", command: "npm install" },
	{ id: "yarn", command: "yarn add" },
	{ id: "pnpm", command: "pnpm add" },
	{ id: "bun", command: "bun add" },
] as const

export const SETUP_TAB_VALUES = ["install", "instrument", "claude-code"] as const
export const PACKAGE_TAB_VALUES = PACKAGE_MANAGERS.map((pm) => pm.id)

export const frameworkIconStrip = <M>(h: HtmlBuilder<M>): Html =>
	h.span(
		[h.Class("text-muted-foreground flex shrink-0 items-center gap-2"), h.AriaHidden(true)],
		sdkSnippets.map((snippet) => icon(h, FRAMEWORK_ICONS[snippet.language], { size: 14 })),
	)

/** `FrameworkPicker`: pill chips (`compact`) or labelled cards under "Pick your stack". */
export const frameworkPicker = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ selected: string; compact: boolean; onSelect: (framework: FrameworkId) => M }>,
): Html => {
	const { compact, selected } = options
	const chips = h.div(
		[h.Class("flex flex-wrap gap-1.5")],
		sdkSnippets.map((snippet) => {
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
									: "border-primary bg-primary/10 text-primary"
								: compact
									? "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
									: "border-border hover:border-foreground/30",
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
	{ name: "ClaudeIcon", className: "text-[#D97757]" },
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
		apiKey: string
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
						CopyButton.Message.ClickedCopy({ text: agentSetupPrompt(ingestUrl, options.apiKey) }),
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
						AGENT_MARKS.map((mark, index) =>
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
								[icon(h, mark.name, { size: 13, className: mark.className })],
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
							...CopyButton.CopyStatus.literals.map((state) =>
								h.span(
									[
										h.AriaHidden(true),
										h.Class("agent-prompt__label"),
										h.DataAttribute("label", state),
									],
									[...AGENT_LABELS[state]].map((char, index) =>
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
	apiKey: string
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
): Html =>
	codeBlock(h, {
		code,
		language,
		className,
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
			labels: PACKAGE_MANAGERS.map((pm) => pm.id),
			panel: (value) => {
				const pm = PACKAGE_MANAGERS.find((entry) => entry.id === value)
				return pm === undefined
					? undefined
					: [block(h, parts, `install:${pm.id}`, `${pm.command} ${packages.join(" ")}`, "shell")]
			},
		},
	})

/** `ConnectInstructions` without credentials: Install / Instrument / Claude Code tabs. */
export const connectInstructions = <M>(h: HtmlBuilder<M>, parts: InstructionsParts<M>): Html => {
	const snippet = sdkSnippets.find((entry) => entry.language === parts.framework)
	if (snippet === undefined) return h.empty
	const isBoxed = parts.variant === "boxed"
	const padding = isBoxed ? "p-3" : "px-4 pt-3 pb-4"
	const apiKey = parts.apiKey
	const interpolate = (template: string) =>
		template
			.replace(/\{\{INGEST_URL\}\}/g, ingestUrl)
			.replace(/\{\{API_KEY\}\}/g, apiKey || "<your-api-key>")
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
			tabClassName: "gap-2",
			tabContent: (value, label) => [
				icon(h, isSetupTab(value) ? SETUP_TAB_ICONS[value] : "CodeIcon", { size: 14 }),
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
						list,
						h.span(
							[
								h.Role("img"),
								h.AriaLabel("OpenTelemetry"),
								h.Title("OpenTelemetry"),
								h.Class("text-muted-foreground"),
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
						block(
							h,
							parts,
							"instrument",
							interpolate(snippet.instrument),
							snippet.label.toLowerCase(),
							REPLAY_BLOCK_CLASS,
						),
						h.a(
							[
								h.Class(
									"mt-3 flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground",
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
						onboardSkillPrompt(ingestUrl, apiKey),
						"shell",
						REPLAY_BLOCK_CLASS,
					),
				]
			},
		},
	})
	return isBoxed ? panel(h, {}, [tabs]) : h.div([], [tabs])
}
