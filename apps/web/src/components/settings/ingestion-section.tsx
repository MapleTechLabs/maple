import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { toastManager } from "@maple/ui/components/ui/toast"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { Button } from "@maple/ui/components/ui/button"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { Panel } from "@maple/ui/components/ui/panel"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { ArrowRightIcon, ChevronRightIcon, KeyIcon, PaperPlaneIcon, PulseIcon } from "@/components/icons"
import { countLabel, formatNumber } from "@maple/ui/lib/format"
import { ingestUrl } from "@/lib/services/common/ingest-url"
import { docsUrl } from "@/lib/docs"
import {
	ConnectInstructions,
	FrameworkIconStrip,
	FrameworkPicker,
	useGuidedFramework,
} from "@/components/ingest/guided-setup"
import {
	sendTestEvent,
	useIngestConnection,
	type IngestConnection,
} from "@/components/ingest/use-ingest-connection"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { AdminOnlyNotice } from "./admin-only-notice"
import { AttributeMappingsSection } from "./attribute-mappings-section"
import { RecommendedMappingsSection } from "./recommended-mappings-section"
import { SettingsSection, SettingsSections } from "./settings-section"

/** Live ingest-health strip: green once telemetry lands, amber pulse while waiting. */
function StatusBanner({ connection }: { connection: IngestConnection }) {
	const connected = connection.status === "connected"

	const [handleSendTest, sending] = useAsyncAction(() => {
		if (!connection.publicKey) return Promise.resolve()
		return sendTestEvent(connection.publicKey).then(
			() => {
				toastManager.add({
					title: "Test event sent. Watch for it to land in traces.",
					type: "success",
				})
				connection.refresh()
			},
			() => {
				toastManager.add({
					title: "Failed to reach the ingest endpoint",
					description: "Double-check your API key.",
					type: "error",
				})
			},
		)
	})

	const spansPerMinute = Math.round(connection.spansPerMinute)

	return (
		<Panel className="flex-row items-center gap-3 px-4 py-2.5">
			{connected ? (
				<StatusDot tone="ok" size="lg" />
			) : (
				<PulseIcon size={12} className="text-primary shrink-0" />
			)}
			<span className="text-sm font-medium whitespace-nowrap">
				{connected ? "Receiving telemetry" : "Waiting for telemetry"}
			</span>
			<span className="text-muted-foreground truncate font-mono text-xs">
				{connected
					? [
							countLabel(connection.serviceCount, "service"),
							spansPerMinute > 0 ? `${formatNumber(spansPerMinute)} spans/min` : null,
						]
							.filter(Boolean)
							.join(" · ")
					: "watching for your first trace"}
			</span>
			<div className="grow" />
			{connected ? (
				<Button
					variant="ghost"
					size="sm"
					className="text-muted-foreground hover:text-foreground gap-1.5"
					render={<Link to="/traces" />}
				>
					Explore traces
					<ArrowRightIcon />
				</Button>
			) : (
				<Button
					variant="outline"
					size="sm"
					className="shrink-0 gap-2"
					onClick={() => void handleSendTest()}
					loading={sending}
					disabled={!connection.publicKey}
				>
					<PaperPlaneIcon />
					Send test event
				</Button>
			)}
		</Panel>
	)
}

/** The OTLP endpoint with copy, and a pointer to where the ingest keys now live. */
function EndpointSection() {
	return (
		<SettingsSection
			title="Endpoint"
			padded={false}
			actions={
				<a
					href={docsUrl("instrumentation")}
					target="_blank"
					rel="noopener noreferrer"
					className="text-muted-foreground hover:text-foreground font-mono text-2xs whitespace-nowrap transition-colors"
				>
					Setup docs ↗
				</a>
			}
		>
			<div className="divide-y">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 sm:flex-nowrap">
					<span className="shrink-0 text-sm sm:w-[120px]">OTLP endpoint</span>
					<Eyebrow variant="mono" className="text-muted-foreground hidden w-14 shrink-0 sm:block">
						HTTP
					</Eyebrow>
					<span className="min-w-0 grow truncate font-mono text-xs">{ingestUrl}</span>
					<CopyButton value={ingestUrl} label="OTLP endpoint" variant="outline" size="icon-sm" />
				</div>
				<div className="text-muted-foreground flex items-center gap-2 px-4 py-2.5 text-xs">
					<KeyIcon size={12} className="shrink-0" />
					<span className="grow">Ingest keys live in Keys.</span>
					<Link
						to="/settings"
						search={{ tab: "keys" }}
						className="text-foreground inline-flex items-center gap-1 hover:underline underline-offset-2"
					>
						Open Keys
						<ChevronRightIcon size={12} />
					</Link>
				</div>
			</div>
		</SettingsSection>
	)
}

/**
 * Install steps for one more service. Once telemetry is arriving this folds into one row, since
 * the steps are a reference by then, not the next thing to do.
 */
function AddServiceSection({ connection }: { connection: IngestConnection }) {
	const { framework, setFramework } = useGuidedFramework()
	const [expanded, setExpanded] = useState(false)
	const connected = connection.status === "connected"
	const open = !connected || expanded

	return (
		<SettingsSection
			title={connected ? "Add another service" : "Send your first telemetry"}
			description={
				connected
					? "Install steps for a new service, or let Claude Code wire it up for you."
					: "Point your OpenTelemetry SDK at Maple, or let Claude Code wire it up for you."
			}
			padded={false}
			actions={open ? <FrameworkPicker compact selected={framework} onSelect={setFramework} /> : null}
		>
			{open ? (
				<ConnectInstructions
					framework={framework}
					apiKey={connection.privateKey}
					apiKeyStatus={connection.apiKeyStatus}
					variant="flush"
				/>
			) : (
				<div className="flex items-center gap-3 px-4 py-3">
					<FrameworkIconStrip />
					<span className="text-muted-foreground min-w-0 grow truncate text-xs">
						Next.js, Node.js, Python, Go, Effect and more
					</span>
					<Button variant="outline" size="sm" onClick={() => setExpanded(true)}>
						Show setup
						<ChevronRightIcon data-icon="inline-end" />
					</Button>
				</div>
			)}
		</SettingsSection>
	)
}

export function IngestionSection() {
	const connection = useIngestConnection()

	return (
		<SettingsSections>
			<AdminOnlyNotice subject="ingestion settings" />
			<StatusBanner connection={connection} />
			<EndpointSection />
			<AddServiceSection connection={connection} />
			<RecommendedMappingsSection />
			<AttributeMappingsSection />
		</SettingsSections>
	)
}
