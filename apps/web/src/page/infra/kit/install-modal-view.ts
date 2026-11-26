import { docsUrl } from "../../kit/docs"
import { codeBlock } from "../../kit/code-block"
import { Schema, String as Str } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import * as DialogView from "@maple/views/ui/dialog-view"
import { heading } from "@maple/views/ui/heading"
import { icon, type IconName } from "@maple/views/ui/icon"
import { inlineCode } from "@maple/views/ui/inline-code"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import * as TabsView from "@maple/views/ui/tabs-view"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import { typography } from "@maple/views/ui/typography"
import {
	InstallTab,
	kubernetesMethod,
	Message,
	type Model,
	MountInstallModal,
	type Snippet,
} from "./install-modal"
import {
	ALCHEMY_FILE,
	alchemyDeployCommand,
	alchemyStack,
	dockerCommand,
	helmCommand,
	HOST_CONFIG,
	hostCommand,
	maskToken,
	TERRAFORM_FILE,
	terraformApplyCommand,
	terraformConfig,
} from "./install-snippets"

// The install modal's dialog, rendered only while open or closing.

type H = HtmlBuilder<Message>

type SnippetPanel = Readonly<{
	snippet: Snippet
	/** The language to highlight as. */
	lang: string
	/** The file the snippet is saved as; a command has none. */
	fileName?: string
	isLoading: boolean
	/** What Copy writes. */
	value: string
	/** What shows: `value` with the key masked unless revealed. */
	display: string
	hasReveal: boolean
}>

// A file shows this many lines until opened, so the command under it stays in view.
const FILE_LINES = 12

const revealButton = (h: H, model: Model): Html =>
	button(
		h,
		{
			variant: "ghost",
			size: "xs",
			attributes: [
				h.AriaLabel(model.isRevealed ? "Hide key" : "Reveal key"),
				h.OnClick(Message.ClickedToggleReveal()),
			],
		},
		[icon(h, "EyeIcon", { size: 12 }), model.isRevealed ? "Hide key" : "Reveal key"],
	)

const snippetPanel = (h: H, model: Model, panel: SnippetPanel): Html =>
	panel.isLoading
		? skeleton(h, "h-24 w-full")
		: codeBlock(h, {
				code: panel.display,
				copyValue: panel.value,
				language: "shell",
				fileName: panel.fileName,
				lang: panel.lang,
				copy: model.copies[panel.snippet],
				toCopyMessage: (message) => Message.GotCopyMessage({ snippet: panel.snippet, message }),
				actions: panel.hasReveal ? [revealButton(h, model)] : undefined,
				// A one-line command wraps to show whole; one already broken into lines keeps them and scrolls.
				wrap: panel.fileName === undefined && !Str.includes("\n")(panel.display),
				fold:
					panel.fileName === undefined
						? undefined
						: {
								isOpen: model.openFiles.includes(panel.snippet),
								lines: FILE_LINES,
								onToggle: Message.ClickedToggleFile({ snippet: panel.snippet }),
							},
			})

type Children = ReadonlyArray<Html | string>

const note = (h: H, children: Children): Html =>
	typography(h, { size: "xs", tone: "muted", as: "p" }, children)

/** What the tab installs, once, above its steps. */
const intro = (h: H, children: Children): Html =>
	typography(h, { size: "sm", tone: "muted", as: "p" }, children)

const code = (h: H, text: string): Html => inlineCode(h, {}, [text])

/** One thing to do: what it is, a line of detail, the snippet, and a note that belongs to the snippet. */
const step = (h: H, parts: Readonly<{ title: Children; hint?: Children; block: Html; after?: Html }>): Html =>
	vstack(h, { gap: "2", className: "min-w-0" }, [
		vstack(h, { gap: "0.5" }, [
			heading(h, { level: 3, variant: "subsection" }, parts.title),
			...(parts.hint === undefined ? [] : [note(h, parts.hint)]),
		]),
		parts.block,
		...(parts.after === undefined ? [] : [parts.after]),
	])

/** Sits under each command that carries the key. */
const keyNote = (h: H): Html =>
	note(h, [
		"This command carries your org's",
		" ",
		typography(h, { weight: "medium", tone: "foreground" }, ["private ingest key"]),
		". Rotate it in Settings → Ingestion if it leaks.",
	])

/** `value` is what Copy writes; `display` masks the key unless revealed. */
const keyed = (model: Model, build: (token: string) => string) => {
	const token = AsyncData.getOrElse(model.ingestKey, () => "")
	const value = token === "" ? "" : build(token)
	return {
		isLoading: AsyncData.isLoading(model.ingestKey) || AsyncData.isIdle(model.ingestKey),
		value,
		display: model.isRevealed || token === "" ? value : build(maskToken(token)),
	}
}

/** A file with no key in it: shown as is, with no reveal. */
const filePanel = (
	h: H,
	model: Model,
	snippet: Snippet,
	fileName: string,
	lang: string,
	text: string,
): Html =>
	snippetPanel(h, model, {
		snippet,
		fileName,
		lang,
		isLoading: false,
		value: text,
		display: text,
		hasReveal: false,
	})

/** A command carrying the key, masked until revealed. */
const commandPanel = (h: H, model: Model, snippet: Snippet, build: (token: string) => string): Html =>
	snippetPanel(h, model, { snippet, lang: "shell", ...keyed(model, build), hasReveal: true })

const saveStep = (
	h: H,
	model: Model,
	file: Readonly<{ snippet: Snippet; name: string; lang: string; text: string; hint: Children }>,
): Html =>
	step(h, {
		title: ["Save this as ", code(h, file.name)],
		hint: file.hint,
		block: filePanel(h, model, file.snippet, file.name, file.lang, file.text),
	})

const commandStep = (
	h: H,
	model: Model,
	command: Readonly<{
		snippet: Snippet
		title: string
		hint?: Children
		build: (token: string) => string
	}>,
): Html =>
	step(h, {
		title: [command.title],
		hint: command.hint,
		block: commandPanel(h, model, command.snippet, command.build),
		after: keyNote(h),
	})

const labelled = (h: H, name: IconName, label: string): ReadonlyArray<Html | string> => [
	icon(h, name, { size: 14 }),
	label,
]

const methodToggle = (h: H, model: Model): Html =>
	hstack(h, { gap: "3", align: "center", wrap: true }, [
		typography(h, { size: "sm", weight: "medium" }, ["Install with"]),
		ToggleGroup.view(h, {
			model: model.methods,
			toParentMessage: (message) => Message.GotMethodMessage({ message }),
			items: [
				{ value: "helm", label: "Helm", children: labelled(h, "HelmIcon", "Helm") },
				{ value: "alchemy", label: "Alchemy", children: labelled(h, "AlchemyIcon", "Alchemy") },
				{
					value: "terraform",
					label: "Terraform",
					children: labelled(h, "TerraformIcon", "Terraform"),
				},
			],
			variant: "outline",
			size: "sm",
		}),
	])

const kubernetesSteps = (h: H, model: Model): ReadonlyArray<Html> => {
	const method = kubernetesMethod(model)
	if (method === "alchemy")
		return [
			saveStep(h, model, {
				snippet: "alchemy",
				name: ALCHEMY_FILE,
				lang: "typescript",
				text: alchemyStack(),
				hint: [
					"The deploy command pins it to your current kubeconfig context and makes the namespace. Pod auto-instrumentation stays off: it needs Helm's install hooks.",
				],
			}),
			commandStep(h, model, {
				snippet: "alchemyDeploy",
				title: "Deploy it",
				build: alchemyDeployCommand,
			}),
		]
	if (method === "terraform")
		return [
			saveStep(h, model, {
				snippet: "terraform",
				name: TERRAFORM_FILE,
				lang: "hcl",
				text: terraformConfig(),
				hint: ["The apply command pins it to your current kubeconfig context. Pod auto-instrumentation stays off."],
			}),
			commandStep(h, model, {
				snippet: "terraformApply",
				title: "Apply it",
				build: terraformApplyCommand,
			}),
		]
	return [
		commandStep(h, model, {
			snippet: "helm",
			title: "Run this against your cluster",
			hint: ["For production, use an existing Secret instead of an inline key. See the docs."],
			build: helmCommand,
		}),
	]
}

const panelFor = (h: H, model: Model, value: string): ReadonlyArray<Html> => {
	if (value === "kubernetes")
		return [
			intro(h, [
				"Maple's Helm chart runs a DaemonSet for node and kubelet metrics, and one deployment for cluster-wide signals.",
			]),
			methodToggle(h, model),
			...kubernetesSteps(h, model),
		]
	if (value === "docker")
		return [
			intro(h, [
				"One container with read-only access to the Docker socket. It reports CPU, memory, network and block I/O for every container, and accepts app OTLP on 4317 and 4318.",
			]),
			commandStep(h, model, {
				snippet: "docker",
				title: "Run the agent",
				hint: ["Container logs come from the mounted log directory. Drop that mount to skip them."],
				build: dockerCommand,
			}),
		]
	return [
		intro(h, [
			"For any Linux, macOS or Windows machine outside Kubernetes. On Kubernetes, the Helm chart already reports every node.",
		]),
		saveStep(h, model, {
			snippet: "hostConfig",
			name: "config.yaml",
			lang: "yaml",
			text: HOST_CONFIG,
			hint: [
				"Install the OpenTelemetry Collector Contrib distribution, ",
				code(h, "otelcol-contrib"),
				", first. This is its config.",
			],
		}),
		commandStep(h, model, { snippet: "host", title: "Start the collector", build: hostCommand }),
	]
}

const TAB_ICONS = {
	kubernetes: "KubernetesIcon",
	docker: "DockerIcon",
	hosts: "ServerIcon",
} as const satisfies Record<InstallTab, IconName>

const isInstallTab = Schema.is(InstallTab)

const content = (h: H, model: Model, close: ReadonlyArray<ChildAttribute>): ReadonlyArray<Html> => [
	DialogView.dialogHeader(h, "dialog", [
		DialogView.dialogTitle(h, "dialog", model.dialog.id, "Install a collector"),
		DialogView.dialogDescription(
			h,
			"dialog",
			model.dialog.id,
			"Pick where your workloads run. Each path uses your org's ingest key and starts reporting within about a minute.",
		),
	]),
	DialogView.dialogPanel(h, "dialog", model.dialog.id, [
		h.div(
			[h.Class("min-w-0")],
			[
				h.submodel({
					slotId: "install-tabs",
					model: model.tabs,
					view: TabsView.view,
					toParentMessage: (message) => Message.GotTabsMessage({ message }),
					viewInputs: {
						labels: ["Kubernetes", "Docker", "Host"],
						tabContent: (value: string, label: string) =>
							isInstallTab(value) ? labelled(h, TAB_ICONS[value], label) : [label],
						variant: "underline",
						ariaLabel: "Where the collector runs",
						wrapList: (list: Html) => h.div([h.Class("border-b border-border")], [list]),
						panelClassName: "space-y-5 pt-3",
						panel: (value) => panelFor(h, model, value),
					},
				}),
			],
		),
	]),
	DialogView.dialogFooter(h, "dialog", [
		button(h, { variant: "outline", attributes: [...close] }, ["Close"]),
		linkButton(
			h,
			{
				variant: "outline",
				href: docsUrl(
					model.tabs.selected === "docker"
						? "docker"
						: model.tabs.selected === "hosts"
							? "hosts"
							: "kubernetes",
				),
				attributes: [h.Target("_blank"), h.Rel("noopener noreferrer"), h.AriaLabel("View docs")],
			},
			["View docs"],
		),
	]),
]

/** The modal's portal while open or closing. */
export const view = Submodel.defineView<Model, Message>((model, h) =>
	h.submodel({
		slotId: `${model.id}-dialog`,
		model: model.dialog,
		view: DialogView.view,
		viewInputs: {
			className: "max-w-3xl overflow-hidden",
			hasTrigger: false,
			toView: ({ portal }) => portal,
			toContent: (close) => content(h, model, close),
		},
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
	}),
)

/**
 * The modal as the setup empty state mounts it: a hidden holder whose Mount fetches the key when the
 * empty state appears (the portal moves itself to `<body>`, so the holder adds no layout).
 */
export const mountedView = Submodel.defineView<Model, Message>((model, h) =>
	h.span(
		[h.Hidden(true), h.OnMount(MountInstallModal())],
		[
			h.submodel({
				slotId: `${model.id}-dialog`,
				model: model.dialog,
				view: DialogView.view,
				viewInputs: {
					className: "max-w-3xl overflow-hidden",
					hasTrigger: false,
					toView: ({ portal }) => portal,
					toContent: (close) => content(h, model, close),
				},
				toParentMessage: (message) => Message.GotDialogMessage({ message }),
			}),
		],
	),
)
