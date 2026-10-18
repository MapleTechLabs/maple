import { REPLAY_BLOCK_CLASS } from "@maple/web/components/common/replay-privacy"
import { ONBOARD_SKILL_COMMAND, onboardSkillPrompt } from "@maple/web/components/ingest/onboard-skill"
import { type FrameworkId, sdkSnippets } from "@maple/web/components/quick-start/sdk-snippets"
import { ingestUrl } from "@maple/web/lib/services/common/ingest-url"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "../../../ui/copy-button"
import { icon, type IconName } from "../../../ui/icon"
import { inlineCode } from "../../../ui/inline-code"
import * as TabsView from "../../../ui/tabs-view"
import { codeBlock } from "../kit/code-block"
import { Message } from "./message"
import type { Model } from "./model"

// `FrameworkIconStrip`, `FrameworkPicker compact` and `ConnectInstructions variant="flush"`
// (apps/web/src/components/ingest/guided-setup.tsx), with `PackageManagerCodeBlock`.

type H = HtmlBuilder<Message>

const FRAMEWORK_ICONS = {
	nextjs: "FrameworkNextjsIcon",
	nodejs: "FrameworkNodejsIcon",
	python: "FrameworkPythonIcon",
	go: "FrameworkGoIcon",
	effect: "FrameworkEffectIcon",
	otel: "FrameworkOpenTelemetryIcon",
} as const satisfies { readonly [Id in FrameworkId]: IconName }

const PACKAGE_MANAGERS = [
	{ id: "npm", command: "npm install" },
	{ id: "yarn", command: "yarn add" },
	{ id: "pnpm", command: "pnpm add" },
	{ id: "bun", command: "bun add" },
] as const

export const frameworkIconStrip = (h: H): Html =>
	h.span(
		[h.Class("text-muted-foreground flex shrink-0 items-center gap-2"), h.AriaHidden(true)],
		sdkSnippets.map((snippet) => icon(h, FRAMEWORK_ICONS[snippet.language], { size: 14 })),
	)

export const frameworkPicker = (h: H, selected: string): Html =>
	h.div(
		[h.Class("flex flex-wrap gap-1.5")],
		sdkSnippets.map((snippet) => {
			const isActive = selected === snippet.language
			return h.button(
				[
					h.Key(snippet.language),
					h.Type("button"),
					h.OnClick(Message.ClickedFramework({ framework: snippet.language })),
					h.Class(
						cn(
							"flex items-center gap-1.5 border font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
							"rounded-full px-2.5 py-1 font-mono text-2xs leading-3.5",
							isActive
								? "border-primary text-primary"
								: "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30",
						),
					),
				],
				[icon(h, FRAMEWORK_ICONS[snippet.language], { size: 12 }), snippet.label],
			)
		}),
	)

const block = (h: H, model: Model, key: string, code: string, language: string, className?: string): Html =>
	codeBlock(h, {
		code,
		language,
		className,
		copy: model.snippetCopies[key] ?? CopyButton.init(),
		toCopyMessage: (message) => Message.GotSnippetCopyMessage({ snippet: key, message }),
	})

const packageManagerBlock = (h: H, model: Model, packages: ReadonlyArray<string>): Html =>
	h.submodel({
		slotId: "ingestion-package-tabs",
		model: model.packageTabs,
		view: TabsView.view,
		toParentMessage: (message) => Message.GotPackageTabsMessage({ message }),
		viewInputs: {
			labels: PACKAGE_MANAGERS.map((pm) => pm.id),
			panel: (value) => {
				const pm = PACKAGE_MANAGERS.find((entry) => entry.id === value)
				return pm === undefined ? undefined : [block(h, model, `install:${pm.id}`, `${pm.command} ${packages.join(" ")}`, "shell")]
			},
		},
	})

export const connectInstructions = (h: H, model: Model, apiKey: string): Html => {
	const snippet = sdkSnippets.find((entry) => entry.language === model.framework)
	if (snippet === undefined) return h.empty
	const padding = "px-4 pt-3 pb-4"
	const interpolate = (template: string) =>
		template.replace(/\{\{INGEST_URL\}\}/g, ingestUrl).replace(/\{\{API_KEY\}\}/g, apiKey || "<your-api-key>")
	const install = snippet.install
	return h.div(
		[],
		[
			h.submodel({
				slotId: "ingestion-setup-tabs",
				model: model.setupTabs,
				view: TabsView.view,
				toParentMessage: (message) => Message.GotSetupTabsMessage({ message }),
				viewInputs: {
					variant: "underline",
					labels: ["Install", "Instrument", "Claude Code"],
					className: "flex flex-col",
					listClassName: "h-9",
					wrapList: (list) => h.div([h.Class("border-b px-4")], [list]),
					panelClassName: cn("overflow-auto mt-0", padding),
					panelClassNameFor: (value) => (value === "claude-code" ? "space-y-2" : undefined),
					panel: (value) => {
						if (value === "install")
							return [
								typeof install === "string"
									? block(h, model, "install", install, "shell")
									: packageManagerBlock(h, model, install.packages),
							]
						if (value === "instrument")
							return [
								block(h, model, "instrument", interpolate(snippet.instrument), snippet.label.toLowerCase(), REPLAY_BLOCK_CLASS),
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
							block(h, model, "skill-command", ONBOARD_SKILL_COMMAND, "shell"),
							block(h, model, "skill-prompt", onboardSkillPrompt(ingestUrl, apiKey), "shell", REPLAY_BLOCK_CLASS),
						]
					},
				},
			}),
		],
	)
}
