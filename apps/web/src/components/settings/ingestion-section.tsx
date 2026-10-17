import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { toastManager } from "@maple/ui/components/ui/toast"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { CopyIndicator } from "@maple/ui/components/ui/copy-button"
import { maskKey } from "@maple/ui/components/ui/copyable-field"
import { IconButton } from "@maple/ui/components/ui/icon-button"
import { Panel } from "@maple/ui/components/ui/panel"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { useCopy } from "@maple/ui/hooks/use-copy"
import { cn } from "@maple/ui/lib/utils"
import {
	ArrowPathIcon,
	ArrowRightIcon,
	ChevronRightIcon,
	EyeIcon,
	PaperPlaneIcon,
	PulseIcon,
} from "@/components/icons"
import { REPLAY_BLOCK_CLASS } from "@/components/common/replay-privacy"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiV2AtomClient, retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { toastExit } from "@/lib/error-toast"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
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

interface CredentialRowProps {
	label: string
	badge: string
	badgeClass: string
	/** `null` while the value is still loading (or failed to, with `failed`). */
	value: string | null
	failed?: boolean
	masked?: boolean
	description?: string
	isVisible?: boolean
	onToggleVisibility?: () => void
	/** Clipboard payload; defaults to `value` (which may be masked for display). */
	copyValue?: string
	onRegenerate?: () => void
	disabled?: boolean
}

function CredentialRow({
	label,
	badge,
	badgeClass,
	value,
	masked = false,
	description,
	isVisible = false,
	onToggleVisibility,
	copyValue,
	failed = false,
	onRegenerate,
	disabled = false,
}: CredentialRowProps) {
	// One copy state drives both affordances — the inline value and the trailing
	// button — so they can never disagree about what was just copied.
	const { copy, status } = useCopy({ label })
	const isDisabled = disabled || value === null
	const onCopy = () => {
		if (value !== null) void copy(copyValue ?? value)
	}
	const hidden = masked && !isVisible

	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 sm:flex-nowrap">
			<span className="w-full shrink-0 text-sm sm:w-[120px]">{label}</span>
			<Eyebrow variant="mono" className={cn("hidden w-14 shrink-0 sm:block", badgeClass)}>
				{badge}
			</Eyebrow>
			<div className="flex min-w-0 grow basis-0 flex-col items-start gap-0.5">
				{value === null && failed ? (
					<span className="text-muted-foreground text-xs">Could not load this key.</span>
				) : value === null ? (
					<Skeleton className="h-4 w-40 max-w-full" />
				) : (
					<button
						type="button"
						onClick={onCopy}
						disabled={isDisabled}
						aria-label={`Copy ${label}`}
						// A revealed key is plain text, which the dashboard's own rrweb recording would capture.
						className={cn(
							masked && REPLAY_BLOCK_CLASS,
							"group/value text-muted-foreground hover:text-foreground flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 text-left font-mono text-xs tracking-wide transition-colors",
						)}
					>
						<span className={hidden ? "truncate" : "min-w-0 break-all"}>
							{hidden ? maskKey(value) : value}
						</span>
						<CopyIndicator
							status={status}
							iconSize={12}
							className={cn(
								"shrink-0 transition-opacity group-hover/value:opacity-100",
								status === "idle" && "opacity-0",
							)}
						/>
					</button>
				)}
				{description && (
					<span className="text-muted-foreground/70 text-2xs leading-3.5">{description}</span>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				{onToggleVisibility && (
					<IconButton
						variant="outline"
						onClick={onToggleVisibility}
						label={isVisible ? "Hide key" : "Reveal key"}
						disabled={isDisabled}
					>
						<EyeIcon className={isVisible ? "text-foreground" : "text-muted-foreground"} />
					</IconButton>
				)}
				<IconButton variant="outline" onClick={onCopy} label={`Copy ${label}`} disabled={isDisabled}>
					<CopyIndicator status={status} iconSize={13} />
				</IconButton>
				{onRegenerate && (
					<IconButton
						variant="outline"
						onClick={onRegenerate}
						label={`Roll ${label.toLowerCase()}`}
						disabled={disabled}
					>
						<ArrowPathIcon className="text-destructive" />
					</IconButton>
				)}
			</div>
		</div>
	)
}

/** The OTLP endpoint plus the org's ingest key pair. The pair is admin-only, so members see the endpoint. */
function EndpointAndKeysSection() {
	const isAdmin = useIsOrgAdmin()
	return (
		<SettingsSection
			title={isAdmin ? "Endpoint & keys" : "Endpoint"}
			description="Point your OTLP exporter at the endpoint and authenticate with an ingest key."
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
				<CredentialRow
					label="OTLP endpoint"
					badge="HTTP"
					badgeClass="text-muted-foreground"
					value={ingestUrl}
				/>
				{isAdmin ? <IngestKeyRows /> : null}
			</div>
		</SettingsSection>
	)
}

function IngestKeyRows() {
	const [publicKeyVisible, setPublicKeyVisible] = useState(false)
	const [privateKeyVisible, setPrivateKeyVisible] = useState(false)
	const [rollOpen, setRollOpen] = useState(false)
	const [rollType, setRollType] = useState<"public" | "private">("public")

	const keysQueryAtom = retainedQueryV2("ingestKeys", "retrieve", {})
	const keysResult = useAtomValue(keysQueryAtom)
	const refreshKeys = useAtomRefresh(keysQueryAtom)

	const rollPublic = useAtomSet(MapleApiV2AtomClient.mutation("ingestKeys", "rollPublic"), {
		mode: "promiseExit",
	})
	const rollPrivate = useAtomSet(MapleApiV2AtomClient.mutation("ingestKeys", "rollPrivate"), {
		mode: "promiseExit",
	})

	function openRoll(keyType: "public" | "private") {
		setRollType(keyType)
		setRollOpen(true)
	}

	const [handleRoll, rolling] = useAsyncAction(async () => {
		const isPublic = rollType === "public"
		const result = isPublic ? await rollPublic({}) : await rollPrivate({})
		const ok = toastExit(result, {
			success: `${isPublic ? "Public" : "Private"} ingest key rolled. The previous key stopped working immediately.`,
			error: "Unable to roll the ingest key",
		})
		if (ok) refreshKeys()
		setRollOpen(false)
	})
	const isBusy = !Result.isSuccess(keysResult) || rolling
	const failed = Result.isFailure(keysResult)

	const publicKey = Result.builder(keysResult)
		.onSuccess((v): string | null => v.public_key)
		.orElse(() => null)
	const privateKey = Result.builder(keysResult)
		.onSuccess((v): string | null => v.private_key)
		.orElse(() => null)

	return (
		<>
			<CredentialRow
				label="Public key"
				badge="Client"
				badgeClass="text-info"
				value={publicKey}
				failed={failed}
				masked
				description="For browser and client-side telemetry SDKs"
				isVisible={publicKeyVisible}
				onToggleVisibility={() => setPublicKeyVisible((v) => !v)}
				onRegenerate={() => openRoll("public")}
				disabled={isBusy}
			/>
			<CredentialRow
				label="Private key"
				badge="Server"
				badgeClass="text-warning"
				value={privateKey}
				failed={failed}
				masked
				description="For server-side SDKs and collectors"
				isVisible={privateKeyVisible}
				onToggleVisibility={() => setPrivateKeyVisible((v) => !v)}
				onRegenerate={() => openRoll("private")}
				disabled={isBusy}
			/>
			<ConfirmDialog
				open={rollOpen}
				onOpenChange={setRollOpen}
				title={`Roll ${rollType} ingest key?`}
				description={
					<>
						This action cannot be undone. Everything sending telemetry with this key will be
						rejected immediately. You will need to update your{" "}
						{rollType === "public" ? "client-side SDKs" : "server configurations"} with the new
						key.
					</>
				}
				confirmLabel="Roll key"
				onConfirm={() => void handleRoll()}
				pending={rolling}
			/>
		</>
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
			<EndpointAndKeysSection />
			<AddServiceSection connection={connection} />
			<RecommendedMappingsSection />
			<AttributeMappingsSection />
		</SettingsSections>
	)
}
