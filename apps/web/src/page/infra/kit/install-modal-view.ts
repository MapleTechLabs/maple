import { docsUrl } from "../../kit/docs"
import { codeBlock } from "../../kit/code-block"
import { Schema } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import * as DialogView from "@maple/views/ui/dialog-view"
import { icon, type IconName } from "@maple/views/ui/icon"
import { skeleton } from "@maple/views/ui/skeleton"
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
	/** The block's eyebrow: a file name or what the command does. */
	label: string
	/** The language to highlight as. */
	lang: string
	isLoading: boolean
	/** What Copy writes. */
	value: string
	/** What shows: `value` with the key masked unless revealed. */
	display: string
	hasReveal: boolean
	/** A whole file: capped in height and scrolled, so the command under it stays in view. */
	isFile?: boolean
}>

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
				language: panel.label,
				lang: panel.lang,
				copy: model.copies[panel.snippet],
				toCopyMessage: (message) => Message.GotCopyMessage({ snippet: panel.snippet, message }),
				actions: panel.hasReveal ? [revealButton(h, model)] : undefined,
				bodyClassName: panel.isFile === true ? "max-h-64 overflow-y-auto" : undefined,
			})

const note = (h: H, children: ReadonlyArray<Html | string>): Html =>
	typography(h, { size: "xs", tone: "muted", as: "p" }, children)

const code = (h: H, text: string): Html => h.code([h.Class("font-mono")], [text])

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
const filePanel = (h: H, model: Model, snippet: Snippet, label: string, lang: string, text: string): Html =>
	snippetPanel(h, model, {
		snippet,
		label,
		lang,
		isLoading: false,
		value: text,
		display: text,
		hasReveal: false,
		isFile: true,
	})

/** A command carrying the key, masked until revealed. */
const commandPanel = (
	h: H,
	model: Model,
	snippet: Snippet,
	label: string,
	build: (token: string) => string,
): Html => snippetPanel(h, model, { snippet, label, lang: "shell", ...keyed(model, build), hasReveal: true })

const labelled = (h: H, name: IconName, label: string): ReadonlyArray<Html | string> => [
	icon(h, name, { size: 14 }),
	label,
]

const methodToggle = (h: H, model: Model): Html =>
	ToggleGroup.view(h, {
		model: model.methods,
		toParentMessage: (message) => Message.GotMethodMessage({ message }),
		items: [
			{ value: "helm", label: "Helm", children: labelled(h, "HelmIcon", "Helm") },
			{ value: "alchemy", label: "Alchemy", children: labelled(h, "AlchemyIcon", "Alchemy") },
			{ value: "terraform", label: "Terraform", children: labelled(h, "TerraformIcon", "Terraform") },
		],
		variant: "outline",
		size: "sm",
	})

const kubernetesPanel = (h: H, model: Model): ReadonlyArray<Html> => {
	const method = kubernetesMethod(model)
	const chart =
		"The Maple Helm chart deploys a DaemonSet for per-node host + kubelet metrics and a single-replica deployment for cluster-wide signals."
	if (method === "alchemy")
		return [
			methodToggle(h, model),
			note(h, [
				`${chart} Save this as `,
				code(h, ALCHEMY_FILE),
				" and deploy it with the command below; it targets your kubeconfig's current context. Pod auto-instrumentation stays off: it needs Helm's install hooks.",
			]),
			filePanel(h, model, "alchemy", ALCHEMY_FILE, "typescript", alchemyStack()),
			commandPanel(h, model, "alchemyDeploy", "Deploy", alchemyDeployCommand),
		]
	if (method === "terraform")
		return [
			methodToggle(h, model),
			note(h, [
				`${chart} Save this as `,
				code(h, TERRAFORM_FILE),
				" (or merge it into a module of yours) and apply it with the command below. Pod auto-instrumentation stays off.",
			]),
			filePanel(h, model, "terraform", TERRAFORM_FILE, "hcl", terraformConfig()),
			commandPanel(h, model, "terraformApply", "Apply", terraformApplyCommand),
		]
	return [
		methodToggle(h, model),
		note(h, [
			`${chart} Run the command against your cluster. For production, prefer an existing Secret over an inline value. See the docs.`,
		]),
		commandPanel(h, model, "helm", "Install", helmCommand),
	]
}

const panelFor = (h: H, model: Model, value: string): ReadonlyArray<Html> => {
	if (value === "kubernetes") return kubernetesPanel(h, model)
	if (value === "docker")
		return [
			note(h, [
				"The Maple Docker agent runs as a single container with read-only access to the Docker socket and streams per-container CPU, memory, network, and block I/O, plus container logs via the mounted log directory (drop that mount to skip logs). It also accepts app OTLP on 4317/4318.",
			]),
			commandPanel(h, model, "docker", "docker run", dockerCommand),
		]
	return [
		note(h, [
			"For any Linux, macOS or Windows machine outside Kubernetes. Install the OpenTelemetry Collector Contrib distribution (",
			code(h, "otelcol-contrib"),
			"), save this as",
			" ",
			code(h, "config.yaml"),
			", then start it with the command below. On Kubernetes, the Helm chart already reports every node.",
		]),
		filePanel(h, model, "hostConfig", "config.yaml", "yaml", HOST_CONFIG),
		commandPanel(h, model, "host", "Run", hostCommand),
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
			[h.Class("space-y-4 min-w-0")],
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
						panelClassName: "space-y-4 pt-3",
						panel: (value) => panelFor(h, model, value),
					},
				}),
				note(h, [
					"The command embeds your org's",
					" ",
					h.strong([h.Class("text-foreground")], ["private ingest key"]),
					". Rotate it from Settings → Ingestion if it leaks.",
				]),
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
			className: "max-w-2xl overflow-hidden",
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
					className: "max-w-2xl overflow-hidden",
					hasTrigger: false,
					toView: ({ portal }) => portal,
					toContent: (close) => content(h, model, close),
				},
				toParentMessage: (message) => Message.GotDialogMessage({ message }),
			}),
		],
	),
)
