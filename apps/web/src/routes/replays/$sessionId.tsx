import { warmAtoms } from "@effect-router/core"
import { shortId } from "@maple/ui/lib/ids"
import { useMemo } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { ResultPage } from "@/components/layout/result-page"
import { ReplayStudio } from "@/components/replays/replay-studio"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	getReplayManifestResultAtom,
	getReplayResultAtom,
	getSessionTranscriptResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { ReplayDetailSkeleton } from "@/components/replays/session-detail-parts"
import { replayPartitionWindow } from "@/components/replays/replay-format"

const detailSearchSchema = Schema.Struct({
	// Session start (warehouse timestamp), set by the list-row link. Used as a
	// partition-pruning hint so the detail queries don't scan the full 30-day
	// retention; absent on deep-links, which then fall back to a full scan.
	t: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/replays/$sessionId")({
	component: ReplayDetailPage,
	validateSearch: Schema.toStandardSchemaV1(detailSearchSchema),
	loaderDeps: ({ search }) => ({ t: search.t }),
	loader: ({ context, params, deps }) => {
		const window = replayPartitionWindow(typeof deps.t === "string" ? deps.t : undefined)
		const data = { sessionId: params.sessionId, ...window }
		warmAtoms(context.effectRegistry, [
			getReplayResultAtom({ data }),
			// The manifest, not the payload: which payload range to fetch depends on
			// where the first checkpoint is, which the manifest is what tells us. That
			// costs one extra round-trip on a cold load and saves fetching a session
			// that can run to hundreds of megabytes.
			getReplayManifestResultAtom({ data }),
			getSessionTranscriptResultAtom({ data }),
		])
	},
})

function ReplayDetailPage() {
	const { sessionId } = Route.useParams()
	const search = Route.useSearch()
	// Recompute the same window the loader prefetched with, so every atom read
	// keys to the identical (prefetched) family entry rather than refetching.
	// Memoized on `t` so its identity is stable — it threads down to the memoized
	// TracesTrack, which must not re-render while the playhead scrubs.
	const t = typeof search.t === "string" ? search.t : undefined
	const window = useMemo(() => replayPartitionWindow(t), [t])
	const detailResult = useAtomValue(getReplayResultAtom({ data: { sessionId, ...window } }))

	// The studio owns its scrolling once loaded; the other states scroll like any page.
	const loaded = Result.isSuccess(detailResult) && Boolean(detailResult.value.data)

	return (
		<ResultPage
			breadcrumbs={[{ label: "Session Replays", href: "/replays" }]}
			result={detailResult}
			select={(detail) => detail.data}
			crumb={() => shortId(sessionId, "session", { length: 8 })}
			fill={loaded}
			errorTitle="Failed to load session replay"
			loading={<ReplayDetailSkeleton />}
			notFound={
				<EmptyMessage dashed className="p-12">
					No metadata for session <InlineCode>{sessionId}</InlineCode>. It may have expired or not
					been ingested yet.
				</EmptyMessage>
			}
		>
			{/* No sticky page header: the studio's identity bar is the header, and `Fill`
			    hands the studio the full height so the player, the timeline and the rail
			    manage their own scrolling. */}
			{(session) => (
				<ReplayStudio
					sessionId={sessionId}
					session={session}
					traceIds={session.traceIds}
					window={window}
				/>
			)}
		</ResultPage>
	)
}
