import { Link } from "@tanstack/react-router"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { ingestUrl } from "@/lib/services/common/ingest-url"
import { CopyableField } from "@maple/ui/components/ui/copyable-field"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

/** Shown instead of the ingest keys to members who can't read them. */
export function IngestKeysUnavailableNote() {
	return (
		<p className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
			Ask an org admin for your ingest keys, or open{" "}
			<Link
				to="/settings"
				search={{ tab: "ingestion" }}
				className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
			>
				Settings → Ingestion
			</Link>
			.
		</p>
	)
}

/** Placeholder for a labelled copyable field whose value is still loading. */
export function CopyableFieldSkeleton({ label }: { label: string }) {
	return (
		<div className="space-y-1">
			<span className="text-xs text-muted-foreground">{label}</span>
			<Skeleton className="h-8 w-full" />
		</div>
	)
}

/**
 * Endpoint + public/private ingest keys as copyable fields, with the
 * permission-failure fallback for members who can't read org keys. Shared by
 * the Connect popover and any compact credentials surface.
 */
export function ConnectCredentials() {
	const keysResult = useAtomValue(retainedQueryV2("ingestKeys", "retrieve", {}))

	return (
		<div className="space-y-3">
			<CopyableField label="Ingest endpoint" value={ingestUrl} />

			{Result.isFailure(keysResult) ? (
				<IngestKeysUnavailableNote />
			) : Result.isSuccess(keysResult) ? (
				<>
					<CopyableField label="Public key" value={keysResult.value.public_key} masked />
					<CopyableField label="Private key" value={keysResult.value.private_key} masked />
				</>
			) : (
				<>
					<CopyableFieldSkeleton label="Public key" />
					<CopyableFieldSkeleton label="Private key" />
				</>
			)}
		</div>
	)
}
