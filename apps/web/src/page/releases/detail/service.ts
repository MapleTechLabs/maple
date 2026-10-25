import type { ReleaseServiceImpact } from "../../../components/releases/release-model"
import { deriveReleaseImpacts } from "../../../components/releases/release-model"
import { Option } from "effect"
import { AsyncData, Command } from "foldkit"
import { ChartRuntime, LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import { commitDetailKey } from "../../kit/commit-card"
import type { Resources } from "../../../platform/resources"
import type { PageContext, PageReturn } from "../../contract"
import { commitMarkers, markerShas } from "../../services/detail/derive-markers"
import { commitRangesKey, isResolvableSha } from "../kit"
import { deriveOf } from "../list/derive"
import type { RequestMode } from "../list/message"
import { FetchChangeset, FetchMarkerCommit, FetchReleaseDetail, FetchServiceIssues } from "./command"
import { Message } from "./message"
import type { Model, ReleaseDetail } from "./model"

// The release body for one service (`?service=`): the version this one replaced is
// read off the list first, then the detail bundle, then what mounts with it (issues, changeset,
// the markers' commits).

type Return = PageReturn<Model, Message>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

export const FINGERPRINT_LIMIT = 50

const withCommands = (model: Model, commands: Commands, result: Return = { model }): Return => ({
	...result,
	model,
	commands: [...(result.commands ?? []), ...commands],
})

/** `ReleaseBody`: the busiest environment's baseline for this service and version. */
export const baselineOf = (model: Model, serviceName: string): string | undefined =>
	Option.getOrUndefined(
		Option.flatMap(AsyncData.getData(model.releases.data), (data) =>
			Option.fromUndefinedOr(
				deriveOf(data)
					.impacts.filter(
						(impact) =>
							impact.serviceName === serviceName && impact.commitSha === model.commitSha,
					)
					.toSorted((a, b) => b.spanCount - a.spanCount)[0]?.baseline?.commitSha,
			),
		),
	)

export type ServiceDerived = Readonly<{
	detail: ReleaseDetail
	impacts: ReadonlyArray<ReleaseServiceImpact>
	impact: ReleaseServiceImpact | undefined
	releases: ReadonlyArray<{ bucket: string; commitSha: string; count: number; errorCount: number }>
}>

/** `ReleaseBodyLoaded`'s memo: impacts, the busiest one of this version, the service's timeline. */
export const derivedOf = (model: Model, serviceName: string): ServiceDerived | undefined =>
	Option.getOrUndefined(
		Option.map(AsyncData.getData(model.detail.data), (detail) => {
			const impacts = deriveReleaseImpacts(
				detail.versions.map((row) => ({ ...row })),
				detail.timeline.map((row) => ({ ...row })),
			)
			return {
				detail,
				impacts,
				impact: impacts
					.filter((candidate) => candidate.commitSha === model.commitSha)
					.toSorted((a, b) => b.spanCount - a.spanCount)[0],
				releases: detail.timeline
					.filter((point) => point.serviceName === serviceName)
					.map((point) => ({
						bucket: point.bucket,
						commitSha: point.commitSha,
						count: point.count,
						errorCount: 0,
					})),
			}
		}),
	)

/** The points the grid draws: this version's, or the baseline's. */
export const seriesPoints = (model: Model, derived: ServiceDerived | undefined) =>
	derived === undefined
		? []
		: model.series === "version"
			? derived.detail.points
			: derived.detail.baselinePoints

/** This release's own commit is the title's read; the markers share it (one `commitQueryAtom`). */
const commitsOf = (model: Model): Model["markerCommits"] =>
	Option.match(AsyncData.getData(model.commit.data), {
		onNone: () => model.markerCommits,
		onSome: (commit) => ({
			...model.markerCommits,
			[model.commitSha]: AsyncData.Success({
				data: {
					sha: commit.sha,
					message: commit.message,
					authorName: commit.authorName,
					authorLogin: commit.authorLogin,
					authorAvatarUrl: commit.authorAvatarUrl,
					committedAt: commit.committedAt,
				},
			}),
		}),
	})

export const markersOf = (model: Model, derived: ServiceDerived | undefined) =>
	derived === undefined
		? []
		: commitMarkers(
				derived.releases,
				seriesPoints(model, derived).map((point) => point.bucket),
				commitsOf(model),
			)

/** What mounts with the loaded detail: the issues of its fingerprints, its changeset, marker commits. */
export const followLoaded = (
	model: Model,
	context: PageContext,
	serviceName: string,
	mode: RequestMode,
): Return => {
	const derived = derivedOf(model, serviceName)
	if (derived === undefined || derived.impact === undefined) return { model }
	const fingerprints = derived.detail.errorFingerprints
		.slice(0, FINGERPRINT_LIMIT)
		.map((row) => row.fingerprintHash)
	const issuesQuery = {
		service_name: serviceName,
		fingerprint_hash: fingerprints.join(","),
		limit: FINGERPRINT_LIMIT,
	}
	const issuesKey = requestKey(context.orgId, "errorIssues.list", issuesQuery)
	const issues =
		fingerprints.length === 0
			? Option.none()
			: Option.map(Keyed.request(model.serviceIssues, issuesKey, mode), (serviceIssues) => ({
					serviceIssues,
					command: FetchServiceIssues({
						key: issuesKey,
						serviceName,
						fingerprints: issuesQuery.fingerprint_hash,
						limit: FINGERPRINT_LIMIT,
					}),
				}))
	const base = derived.impact.baseline?.commitSha
	const ranges = base === undefined ? "" : commitRangesKey([{ base, head: model.commitSha }])
	const changesetKey = requestKey(context.orgId, "vcsCommitRanges", { ranges, limit: 100 })
	const changeset =
		ranges === ""
			? Option.none()
			: Option.map(Keyed.request(model.changeset, changesetKey, mode), (slot) => ({
					changeset: slot,
					command: FetchChangeset({ key: changesetKey, ranges }),
				}))
	const shas = markerShas(markersOf(model, derived)).filter(
		(sha) => sha !== model.commitSha && model.markerCommits[sha] === undefined && isResolvableSha(sha),
	)
	return withCommands(
		{
			...model,
			...Option.match(issues, {
				onNone: () => ({}),
				onSome: ({ serviceIssues }) => ({ serviceIssues }),
			}),
			...Option.match(changeset, {
				onNone: () => ({}),
				onSome: ({ changeset: slot }) => ({ changeset: slot }),
			}),
			markerCommits: {
				...model.markerCommits,
				...Object.fromEntries(shas.map((sha) => [sha, AsyncData.Loading()])),
			},
		},
		[
			...Option.match(issues, { onNone: () => [], onSome: ({ command }) => [command] }),
			...Option.match(changeset, { onNone: () => [], onSome: ({ command }) => [command] }),
			...shas.map((sha) => FetchMarkerCommit({ key: commitDetailKey(context.orgId, sha), sha })),
		],
	)
}

/**
 * `?service=`: once the list answered (the baseline is read off it), the detail bundle for this
 * version and that baseline; then what mounts with it. The plotting runtime loads with the body.
 */
export const followService = (model: Model, context: PageContext, mode: RequestMode): Return => {
	const serviceName = model.search.service
	const window = model.window
	if (serviceName === undefined || window === null) return { model }
	if (!AsyncData.hasData(model.releases.data) && !AsyncData.isFailure(model.releases.data)) return { model }
	const runtime: Return =
		model.chartRuntime === null
			? withCommands({ ...model, chartRuntime: ChartRuntime.Loading() }, [
					Command.mapMessage(LoadChartRuntime(), (message) =>
						message._tag === "CompletedLoadChartRuntime"
							? Message.CompletedLoadChartRuntime()
							: Message.FailedLoadChartRuntime({ reason: message.reason }),
					),
				])
			: { model }
	const input = {
		serviceName,
		commitSha: model.commitSha,
		baselineCommitSha: baselineOf(model, serviceName),
		startTime: window.startTime,
		endTime: window.endTime,
		environments: model.search.environments,
	}
	const key = requestKey(context.orgId, "getReleaseDetail", { data: input })
	const requested: Return = Option.match(Keyed.request(runtime.model.detail, key, mode), {
		onNone: () => runtime,
		onSome: (detail) =>
			withCommands({ ...runtime.model, detail }, [FetchReleaseDetail({ key, ...input, refresh: mode === "Refresh" })], runtime),
	})
	const loaded = followLoaded(requested.model, context, serviceName, mode)
	return withCommands(loaded.model, loaded.commands ?? [], requested)
}
