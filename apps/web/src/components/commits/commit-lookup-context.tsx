import { createContext, useContext, useMemo, type ReactNode } from "react"
import { CommitsLookupRequest, type CommitInfo } from "@maple/domain/http"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

const SHA_REGEX = /^[0-9a-f]{7,40}$/i

interface CommitLookupContextValue {
	readonly lookup: ReadonlyMap<string, CommitInfo | null>
	readonly loading: boolean
}

const Ctx = createContext<CommitLookupContextValue>({
	lookup: new Map(),
	loading: false,
})

export function CommitLookupProvider({
	shas,
	children,
}: {
	shas: ReadonlyArray<string>
	children: ReactNode
}) {
	const validShas = useMemo(() => {
		const seen = new Set<string>()
		for (const sha of shas) {
			if (SHA_REGEX.test(sha)) seen.add(sha)
		}
		return Array.from(seen).sort()
	}, [shas])

	const result = useAtomValue(
		MapleApiAtomClient.query("commits", "commitsLookupBySha", {
			payload: new CommitsLookupRequest({ shas: validShas }),
			reactivityKeys: ["commitLookup", ...validShas],
		}),
	)

	const value = useMemo<CommitLookupContextValue>(() => {
		const lookup = new Map<string, CommitInfo | null>()
		Result.builder(result)
			.onSuccess((response) => {
				for (const entry of response.entries) {
					lookup.set(entry.sha, entry.commit)
				}
			})
			.orElse(() => null)
		return {
			lookup,
			loading: Result.isInitial(result),
		}
	}, [result])

	if (validShas.length === 0) {
		return <Ctx.Provider value={{ lookup: new Map(), loading: false }}>{children}</Ctx.Provider>
	}
	return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useCommitLookup() {
	return useContext(Ctx)
}
