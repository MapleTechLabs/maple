import type { V2Source } from "@maple/domain/http/v2"
import { Alert, AlertTitle } from "@maple/ui/components/ui/alert"
import { CopyableField } from "@maple/ui/components/ui/copyable-field"
import { Panel } from "@maple/ui/components/ui/panel"
import { Link } from "@tanstack/react-router"
import { DetailHeader } from "@/components/common/detail-header"
import { UnderlineTabStrip, underlineTabClass } from "@/components/common/underline-link-tabs"
import { PlatformTile, platformMeta } from "./platforms"
import { hasToken, type RevealedToken, toPublicSourceId } from "./shared"
import { isPushSourcePlatform } from "@maple/domain/primitives"
import { SourceActions } from "./source-actions"
import { SourceSetup } from "./source-setup"
import { SourceStatusBadge, sourceStatus } from "./source-status"

export const SOURCE_TABS = ["overview", "setup", "settings"] as const
export type SourceTab = (typeof SOURCE_TABS)[number]
const TAB_LABELS = { overview: "Overview", setup: "Setup", settings: "Settings" } satisfies Record<
	SourceTab,
	string
>

export function SourceHeader({
	source,
	onRevealed,
	onDeleted,
}: {
	source: V2Source
	onRevealed: (revealed: RevealedToken) => void
	onDeleted: () => void
}) {
	return (
		<DetailHeader
			kind={["Source", platformMeta(source.platform).label, source.is_default ? "Default" : null]}
			title={source.name}
			adornment={<PlatformTile platform={source.platform} size="sm" />}
			meta={
				<>
					<SourceStatusBadge value={sourceStatus(source)} />
					{source.key_prefix !== null && (
						<span className="text-muted-foreground font-mono text-xs">{source.key_prefix}…</span>
					)}
				</>
			}
			actions={
				hasToken(source) ? (
					<SourceActions source={source} onRevealed={onRevealed} onDeleted={onDeleted} />
				) : undefined
			}
		/>
	)
}

export function SourceTabs({ source, active }: { source: V2Source; active: SourceTab }) {
	return (
		<UnderlineTabStrip label="Source sections">
			{SOURCE_TABS.map((tab) => (
				<Link
					key={tab}
					role="tab"
					aria-selected={tab === active}
					to="/sources/$sourceId"
					params={{ sourceId: toPublicSourceId(source.id) }}
					search={{ tab: tab === "overview" ? undefined : tab }}
					className={underlineTabClass(tab === active)}
				>
					{TAB_LABELS[tab]}
				</Link>
			))}
		</UnderlineTabStrip>
	)
}

/** One-time token after a roll, above whichever tab is open. */
export function RolledTokenBanner({ revealed }: { revealed: RevealedToken }) {
	return (
		<Panel padded className="gap-3">
			<Alert variant="ok">
				<AlertTitle>
					Token rolled. Copy it now, it won't be shown again. The old one stops working within a
					minute.
				</AlertTitle>
			</Alert>
			<CopyableField value={revealed.secret} copyLabel="Source token" />
		</Panel>
	)
}

export function SourceSetupTab({ source, revealed }: { source: V2Source; revealed: RevealedToken | null }) {
	if (source.is_default) {
		return (
			<p className="text-muted-foreground text-sm">
				The default source receives everything sent with your organization's ingest keys. Setup steps
				are on the{" "}
				<Link
					to="/settings"
					search={{ tab: "ingestion" }}
					className="text-foreground underline underline-offset-2"
				>
					Ingestion
				</Link>{" "}
				page.
			</p>
		)
	}
	if (!isPushSourcePlatform(source.platform)) {
		return (
			<p className="text-muted-foreground text-sm">
				Maple collects this source through the {platformMeta(source.platform).label} integration.
				Connection settings are on the{" "}
				<Link
					to="/integrations"
					search={{ integration: source.platform }}
					className="text-foreground underline underline-offset-2"
				>
					integration page
				</Link>
				.
			</p>
		)
	}
	return (
		<div className="max-w-3xl">
			<SourceSetup
				platform={source.platform}
				name={source.name}
				token={revealed?.secret ?? null}
				keyPrefix={source.key_prefix}
			/>
		</div>
	)
}
