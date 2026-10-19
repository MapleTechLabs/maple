import type { V2Source } from "@maple/domain/http/v2"
import { Alert, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Button } from "@maple/ui/components/ui/button"
import { CopyableField } from "@maple/ui/components/ui/copyable-field"
import { Panel } from "@maple/ui/components/ui/panel"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { Link } from "@tanstack/react-router"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { type RevealedToken, toPublicSourceId } from "./shared"
import { SourceSetup } from "./source-setup"

const POLL_MS = 5_000

/** Polls the source until the gateway reports its first accepted request. */
export function FirstDataStatus({ source }: { source: V2Source }) {
	const query = retainedQueryV2("sources", "retrieve", { params: { id: source.id } })
	const result = useAtomValue(query)
	const refresh = useAtomRefresh(query)
	const latest = Result.builder(result)
		.onSuccess((value): V2Source => value)
		.orElse(() => source)
	const receiving = latest.last_used_at !== null
	useIntervalRefresh(refresh, { intervalMs: POLL_MS, enabled: !receiving })

	return (
		<Panel className="flex-row items-center gap-3 px-4 py-3">
			{receiving ? <StatusDot tone="ok" size="lg" /> : <Spinner className="size-3.5" />}
			<span className="grow text-sm font-medium">
				{receiving ? "Receiving data" : "Waiting for first data"}
			</span>
			<Button
				variant={receiving ? "default" : "outline"}
				size="sm"
				render={<Link to="/sources/$sourceId" params={{ sourceId: toPublicSourceId(source.id) }} />}
			>
				{receiving ? "Open source" : "Skip for now"}
			</Button>
		</Panel>
	)
}

/** Step 3: the one-time token, the setup snippets, then the first-data watch. */
export function TokenStep({ source, revealed }: { source: V2Source; revealed: RevealedToken }) {
	return (
		<div className="flex w-full max-w-3xl flex-col gap-4">
			<Alert variant="ok">
				<AlertTitle>Source created. Copy the token now, it won't be shown again.</AlertTitle>
				<AlertDescription className="text-xs">
					Use it as the ingest key wherever this source sends from.
				</AlertDescription>
			</Alert>
			<Panel padded className="gap-2">
				<span className="text-sm font-medium">Token</span>
				<CopyableField value={revealed.secret} copyLabel="Source token" />
			</Panel>
			<SourceSetup
				platform={source.platform}
				name={source.name}
				token={revealed.secret}
				keyPrefix={source.key_prefix}
			/>
			<FirstDataStatus source={source} />
		</div>
	)
}
