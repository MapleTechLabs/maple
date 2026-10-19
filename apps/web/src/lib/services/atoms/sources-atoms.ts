import type { V2Source } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { collectV2Pages } from "@/lib/services/common/v2-pagination"

const PAGE_LIMIT = 100

// One shared list: every sources page reads it, and every mutation refreshes it.
export const sourcesListAtom = MapleApiV2AtomClient.runtime.atom(
	Effect.gen(function* () {
		const client = yield* MapleApiV2AtomClient
		const data: ReadonlyArray<V2Source> = yield* collectV2Pages((cursor) =>
			client.sources.list({
				query: { limit: PAGE_LIMIT, ...(cursor !== undefined ? { cursor } : undefined) },
			}),
		)
		return { data }
	}),
)
