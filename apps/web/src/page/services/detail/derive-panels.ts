import type { DependencyBundle } from "./model-tabs"
import type { Release } from "./model"

// Pure halves of the Overview panels (recent deploys, dependency strip).

export type DeployEntry = Readonly<{
	sha: string
	/** First bucket the commit was seen in. */
	firstSeen: string
	spanCount: number
	errorCount: number
}>

/** `deriveDeploys`: one entry per commit, newest first-seen first. */
export const deriveDeploys = (releases: ReadonlyArray<Release>): ReadonlyArray<DeployEntry> => {
	const bySha = releases.reduce((acc, point) => {
		const existing = acc.get(point.commitSha)
		acc.set(
			point.commitSha,
			existing === undefined
				? {
						sha: point.commitSha,
						firstSeen: point.bucket,
						spanCount: point.count,
						errorCount: point.errorCount,
					}
				: {
						...existing,
						spanCount: existing.spanCount + point.count,
						errorCount: existing.errorCount + point.errorCount,
						firstSeen: point.bucket < existing.firstSeen ? point.bucket : existing.firstSeen,
					},
		)
		return acc
	}, new Map<string, DeployEntry>())
	return [...bySha.values()].toSorted((a, b) =>
		a.firstSeen < b.firstSeen ? 1 : a.firstSeen > b.firstSeen ? -1 : 0,
	)
}

/** A full 40-hex git SHA, the only kind the VCS endpoint resolves (`isResolvableSha`). */
export const isResolvableSha = (sha: string): boolean => /^[0-9a-f]{40}$/i.test(sha)

/** `firstLine`: a commit message's subject. */
export const firstLine = (message: string): string => {
	const index = message.indexOf("\n")
	return (index === -1 ? message : message.slice(0, index)).trim()
}

export type DependencyKind = "service" | "database" | "http" | "messaging" | "rpc"

export type StripTarget = Readonly<{ id: string; kind: DependencyKind; name: string; estimatedCalls: number }>

/** The "Talks to" chips: every downstream target, busiest first. */
export const stripTargets = (bundle: DependencyBundle): ReadonlyArray<StripTarget> =>
	[
		...bundle.serviceEdges.flatMap((edge): ReadonlyArray<StripTarget> =>
			edge.targetService === ""
				? []
				: [
						{
							id: `service:${edge.targetService}`,
							kind: "service",
							name: edge.targetService,
							estimatedCalls: edge.estimatedCallCount,
						},
					],
		),
		...bundle.dbEdges.flatMap((edge): ReadonlyArray<StripTarget> =>
			edge.dbSystem === ""
				? []
				: [
						{
							id: `database:${edge.dbSystem}:${edge.dbNamespace}`,
							kind: "database",
							name: edge.dbNamespace ? `${edge.dbSystem} · ${edge.dbNamespace}` : edge.dbSystem,
							estimatedCalls: edge.estimatedCallCount,
						},
					],
		),
		...bundle.externalEdges.flatMap((edge): ReadonlyArray<StripTarget> =>
			edge.targetName === ""
				? []
				: [
						{
							id: `${edge.targetType}:${edge.targetName}`,
							kind: edge.targetType,
							name: edge.targetName,
							estimatedCalls: edge.estimatedCallCount,
						},
					],
		),
	].toSorted((a, b) => b.estimatedCalls - a.estimatedCalls)
