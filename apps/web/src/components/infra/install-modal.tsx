import { Result, useAtomValue } from "@/lib/effect-atom"
import { useMemo, useState } from "react"

import { Button } from "@maple/ui/components/ui/button"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from "@maple/ui/components/ui/input-group"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"

import { EyeIcon } from "@/components/icons"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { docsUrl } from "@/lib/docs"
import { ingestUrl } from "@/lib/services/common/ingest-url"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"

// The endpoint the chart and the agent image default to. The EU region is not it.
const CHART_DEFAULT_INGEST_URL = "https://ingest.maple.dev"

const INSTALL_TABS = ["kubernetes", "docker", "hosts"] as const

/** Each tab is also the `DocsPage` key of its install guide. */
export type InstallTab = (typeof INSTALL_TABS)[number]

function isInstallTab(value: unknown): value is InstallTab {
	return INSTALL_TABS.some((tab) => tab === value)
}

interface InstallModalProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	/** Which collector tab opens first: the containers page opens on Docker. */
	defaultTab?: InstallTab
}

// Mask the secret so it isn't sitting in plaintext (screenshots, shoulder
// surfing). Keep the `maple_sk_` prefix for recognizability and use a
// fixed-width dot run so the real key length isn't leaked.
function maskToken(token: string) {
	const prefix = "maple_sk_"
	return token.startsWith(prefix) ? `${prefix}${"•".repeat(24)}` : "•".repeat(24)
}

function helmCommand(token: string) {
	const lines = [
		"helm upgrade --install maple-k8s-infra \\",
		"  oci://ghcr.io/mapletechlabs/charts/maple-k8s-infra \\",
		"  --namespace maple --create-namespace \\",
		`  --set-string maple.ingestKey.value=${token} \\`,
		"  --set-string global.clusterName=production",
	]
	// Any endpoint but the US one (self-hosted, or the EU region) is passed explicitly. US installs
	// use the chart's baked-in default, so we omit the flag to keep it clean.
	if (ingestUrl !== CHART_DEFAULT_INGEST_URL) {
		lines[lines.length - 1] += " \\"
		lines.push(`  --set-string maple.ingest.endpoint=${ingestUrl}`)
	}
	return lines.join("\n")
}

// The agent must run as root: the docker socket and the json-file log
// directory are not readable by the image's nonroot user.
function dockerCommand(token: string) {
	const lines = [
		"docker run -d --name maple-agent \\",
		"  --restart unless-stopped --user 0:0 \\",
		"  -v /var/run/docker.sock:/var/run/docker.sock:ro \\",
		"  -v /var/lib/docker/containers:/var/lib/docker/containers:ro \\",
		"  -v maple-agent-state:/var/lib/otelcol \\",
		"  -p 4317:4317 -p 4318:4318 \\",
		`  -e MAPLE_INGEST_KEY=${token} \\`,
	]
	if (ingestUrl !== CHART_DEFAULT_INGEST_URL) {
		lines.push(`  -e MAPLE_ENDPOINT=${ingestUrl} \\`)
	}
	lines.push("  ghcr.io/mapletechlabs/maple/otel-collector-maple:0.2.0 \\")
	lines.push("  --config /etc/otel/docker-config.yaml")
	return lines.join("\n")
}

// The hostmetrics config from the hosts docs. It reads the key from the environment, so it
// carries no secret. The three `*.utilization` metrics are off by default and the page needs them.
const HOST_CONFIG = `receivers:
    hostmetrics:
        collection_interval: 30s
        scrapers:
            cpu:
                metrics:
                    system.cpu.utilization:
                        enabled: true
            load: {}
            memory:
                metrics:
                    system.memory.utilization:
                        enabled: true
            filesystem:
                metrics:
                    system.filesystem.utilization:
                        enabled: true
            network: {}

processors:
    resourcedetection:
        detectors: [env, system]
    batch: {}

exporters:
    otlphttp/maple:
        endpoint: ${ingestUrl}
        compression: gzip
        headers:
            x-maple-ingest-key: \${env:MAPLE_INGEST_KEY}

service:
    pipelines:
        metrics:
            receivers: [hostmetrics]
            processors: [resourcedetection, batch]
            exporters: [otlphttp/maple]`

function hostCommand(token: string) {
	return `MAPLE_INGEST_KEY=${token} otelcol-contrib --config config.yaml`
}

interface SnippetPanelProps {
	loading: boolean
	snippet: string
	displaySnippet: string
	rows: number
	revealed: boolean
	/** Omit for snippets that carry no key: the reveal toggle is then hidden. */
	onToggleReveal?: () => void
	copyLabel?: string
}

function SnippetPanel({
	loading,
	snippet,
	displaySnippet,
	rows,
	revealed,
	onToggleReveal,
	copyLabel = "Install command",
}: SnippetPanelProps) {
	if (loading) return <Skeleton className="h-36 w-full" />
	return (
		<InputGroup>
			<InputGroupTextarea
				readOnly
				wrap="off"
				value={displaySnippet}
				rows={rows}
				className="font-mono text-xs tracking-wide select-all leading-relaxed"
			/>
			<InputGroupAddon align="block-end">
				{onToggleReveal ? (
					<InputGroupButton
						onClick={onToggleReveal}
						aria-label={revealed ? "Hide key" : "Reveal key"}
						title={revealed ? "Hide key" : "Reveal key"}
					>
						<EyeIcon size={14} />
						{revealed ? "Hide key" : "Reveal key"}
					</InputGroupButton>
				) : null}
				<CopyButton
					value={snippet}
					label={copyLabel}
					idleLabel="Copy"
					render={<InputGroupButton />}
					className="ml-auto"
				/>
			</InputGroupAddon>
		</InputGroup>
	)
}

export function InstallHostModal({ open, onOpenChange, defaultTab = "kubernetes" }: InstallModalProps) {
	const [revealed, setRevealed] = useState(false)
	const [tab, setTab] = useState<InstallTab>(defaultTab)

	const keysResult = useAtomValue(retainedQueryV2("ingestKeys", "retrieve", {}))

	const token = useMemo(
		() =>
			Result.builder(keysResult)
				.onSuccess((v) => v.private_key)
				.orElse(() => ""),
		[keysResult],
	)

	const loading = Result.isInitial(keysResult)
	const customEndpoint = ingestUrl !== CHART_DEFAULT_INGEST_URL

	// `snippet` is the real command (used for copy); `displaySnippet` masks the
	// key unless the user explicitly reveals it.
	const helmSnippet = useMemo(() => (token ? helmCommand(token) : ""), [token])
	const helmDisplay = useMemo(
		() => (revealed || !token ? helmSnippet : helmCommand(maskToken(token))),
		[revealed, helmSnippet, token],
	)
	const dockerSnippet = useMemo(() => (token ? dockerCommand(token) : ""), [token])
	const dockerDisplay = useMemo(
		() => (revealed || !token ? dockerSnippet : dockerCommand(maskToken(token))),
		[revealed, dockerSnippet, token],
	)
	const hostSnippet = token ? hostCommand(token) : ""
	const hostDisplay = revealed || !token ? hostSnippet : hostCommand(maskToken(token))

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				// Reset to defaults whenever the modal closes: re-mask the key so
				// it's never exposed on the next open, and restore the caller's
				// defaultTab so "opens on Docker" holds per open, not just once.
				if (!next) {
					setRevealed(false)
					setTab(defaultTab)
				}
				onOpenChange(next)
			}}
		>
			<DialogContent className="max-w-2xl overflow-hidden">
				<DialogHeader>
					<DialogTitle>Install a collector</DialogTitle>
					<DialogDescription>
						Pick where your workloads run. Each path uses your org's ingest key and starts
						reporting within about a minute.
					</DialogDescription>
				</DialogHeader>

				<DialogPanel className="space-y-4 min-w-0">
					<Tabs
						value={tab}
						onValueChange={(v) => {
							if (isInstallTab(v)) setTab(v)
						}}
					>
						<TabsList>
							<TabsTrigger value="kubernetes">Kubernetes</TabsTrigger>
							<TabsTrigger value="docker">Docker</TabsTrigger>
							<TabsTrigger value="hosts">Host</TabsTrigger>
						</TabsList>
						<TabsContent value="kubernetes" className="space-y-4 pt-3">
							<p className="text-muted-foreground text-xs">
								The Maple Helm chart deploys a DaemonSet for per-node host + kubelet metrics
								and a single-replica deployment for cluster-wide signals. Run the command
								against your cluster. For production, prefer an existing Secret over an inline
								value. See the docs.
							</p>
							<SnippetPanel
								loading={loading}
								snippet={helmSnippet}
								displaySnippet={helmDisplay}
								rows={customEndpoint ? 6 : 5}
								revealed={revealed}
								onToggleReveal={() => setRevealed((v) => !v)}
							/>
						</TabsContent>
						<TabsContent value="docker" className="space-y-4 pt-3">
							<p className="text-muted-foreground text-xs">
								The Maple Docker agent runs as a single container with read-only access to the
								Docker socket and streams per-container CPU, memory, network, and block I/O,
								plus container logs via the mounted log directory (drop that mount to skip
								logs). It also accepts app OTLP on 4317/4318.
							</p>
							<SnippetPanel
								loading={loading}
								snippet={dockerSnippet}
								displaySnippet={dockerDisplay}
								rows={customEndpoint ? 10 : 9}
								revealed={revealed}
								onToggleReveal={() => setRevealed((v) => !v)}
							/>
						</TabsContent>
						<TabsContent value="hosts" className="space-y-4 pt-3">
							<p className="text-muted-foreground text-xs">
								For any Linux, macOS or Windows machine outside Kubernetes. Install the
								OpenTelemetry Collector Contrib distribution (
								<code className="font-mono">otelcol-contrib</code>), save this as{" "}
								<code className="font-mono">config.yaml</code>, then start it with the command
								below. On Kubernetes, the Helm chart already reports every node.
							</p>
							<SnippetPanel
								loading={false}
								snippet={HOST_CONFIG}
								displaySnippet={HOST_CONFIG}
								rows={12}
								revealed={false}
								copyLabel="Collector config"
							/>
							<SnippetPanel
								loading={loading}
								snippet={hostSnippet}
								displaySnippet={hostDisplay}
								rows={1}
								revealed={revealed}
								onToggleReveal={() => setRevealed((v) => !v)}
							/>
						</TabsContent>
					</Tabs>

					<p className="text-muted-foreground text-xs">
						The command embeds your org's{" "}
						<strong className="text-foreground">private ingest key</strong>. Rotate it from
						Settings → Ingestion if it leaks.
					</p>
				</DialogPanel>

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Close
					</Button>
					<Button
						variant="outline"
						render={
							<a
								href={docsUrl(tab)}
								target="_blank"
								rel="noopener noreferrer"
								aria-label="View docs"
							/>
						}
					>
						View docs
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
