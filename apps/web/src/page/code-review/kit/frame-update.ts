import { type GithubIntegrationStatus, VcsRepositoryId } from "@maple/domain/http"
import type { LoadFailure } from "../../../data/load-failure"
import { Option, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { emptyRetained, type Retained, retainedStatus } from "./retained"
import { requestKey } from "../../../data/request-key"
import * as Select from "../../../ui/select"
import type { PageContext } from "../../contract"
import { routeWindowStep, snapModeOf } from "../../kit/route-window"
import * as TimeRangePicker from "../../kit/time-range-picker"
import {
	ALL,
	CompleteReloadSpin,
	FetchGithubStatus,
	type Frame,
	type FrameCommand,
	FrameMessage,
	type FrameReturn,
	type RequestMode,
	ResolveWindow,
	type WindowSearch,
} from "./frame"

// The frame's `init`, `routeChanged` and `update`; the page maps its Commands and acts on its out.

/** What the shared page instance carries into a tab: retained answers and the last clock read. */
export type Carried = Readonly<{ retained: Retained; nowMs: number }>
export const noCarry: Carried = { retained: emptyRetained, nowMs: 0 }

/** The frame's share of the retained answers: the GitHub status it read. */
export const frameRetained = (frame: Frame): Partial<Retained> =>
	Option.match(AsyncData.getData(frame.githubStatus.data), {
		onNone: () => ({}),
		onSome: (status) => ({
			githubStatus: { [frame.githubStatus.key ?? ""]: { value: status, usedAtMs: frame.nowMs } },
		}),
	})

export type FrameSearch = WindowSearch & Readonly<{ repo?: VcsRepositoryId }>

const isRepositoryId = Schema.is(VcsRepositoryId)

export const resolveCommand = (
	search: WindowSearch,
	defaultPreset: string,
	context: PageContext,
	mode: RequestMode,
): FrameCommand =>
	ResolveWindow({
		mode,
		startTime: search.startTime,
		endTime: search.endTime,
		preset: search.timePreset ?? defaultPreset,
		timeZone: context.timeZone,
	})

export const initFrame = (
	id: string,
	search: FrameSearch,
	option: string | undefined,
	defaultPreset: string,
	context: PageContext,
	carried: Carried = noCarry,
): FrameReturn => {
	const key = requestKey(context.orgId, "integrations.githubStatus", {})
	const retained = retainedStatus(carried.retained, key, carried.nowMs)
	const githubStatus: Frame["githubStatus"] = Option.match(retained, {
		onSome: (status) => ({ key, data: AsyncData.Success({ data: status }) }),
		onNone: () =>
			Option.getOrElse(
				Keyed.request(Keyed.idle<GithubIntegrationStatus, LoadFailure>(), key, "Load"),
				() => Keyed.idle<GithubIntegrationStatus, LoadFailure>(),
			),
	})
	const frame: Frame = {
		repoSelect: Select.init(`${id}-repository`, { value: search.repo ?? ALL, selectedIndex: null }),
		optionSelect: Select.init(`${id}-option`, { value: option ?? ALL, selectedIndex: null }),
		timePicker: TimeRangePicker.init(`${id}-time-range`),
		githubStatus,
		window: null,
		nowMs: 0,
		refreshVersion: 0,
		isReloading: false,
	}
	return {
		frame,
		commands: [
			resolveCommand(search, defaultPreset, context, "Load"),
			...(Option.isSome(retained) ? [] : [FetchGithubStatus({ key })]),
		],
		out: null,
	}
}

/** A new search: the selects follow it; only a moved window resolves again, else the page re-reads under it. */
export const frameRouteChanged = (
	frame: Frame,
	previous: WindowSearch,
	search: FrameSearch,
	option: string | undefined,
	defaultPreset: string,
	context: PageContext,
): FrameReturn => {
	const next: Frame = {
		...frame,
		repoSelect: { ...frame.repoSelect, value: search.repo ?? ALL },
		optionSelect: { ...frame.optionSelect, value: option ?? ALL },
	}
	const resolve = (): FrameReturn => ({
		frame: next,
		commands: [resolveCommand(search, defaultPreset, context, snapModeOf(frame.refreshVersion))],
		out: null,
	})
	return routeWindowStep(previous, search, {
		resolve,
		requestAll: (mode) =>
			frame.window === null ? resolve() : { frame: next, commands: [], out: { _tag: "ResolvedWindow", window: frame.window, mode } },
	})
}

const mapped = <M>(commands: ReadonlyArray<Command.Command<M, never, never>>, wrap: (m: M) => FrameMessage) =>
	Command.mapMessages(commands, wrap)

export const updateFrame = (
	frame: Frame,
	message: FrameMessage,
	search: WindowSearch,
	defaultPreset: string,
	context: PageContext,
): FrameReturn =>
	FrameMessage.match<FrameReturn>(message, {
		// Reload only re-resolves (unsnapped): a window that moved is a new key, an unchanged one
		// is the retained answer.
		CompletedResolveWindow: ({ window, nowMs }) => ({
			frame: { ...frame, window, nowMs },
			commands: [],
			out: { _tag: "ResolvedWindow", window, mode: "Load" },
		}),
		CompletedFetchGithubStatus: ({ key, result }) => ({
			frame: { ...frame, githubStatus: Keyed.accept(frame.githubStatus, key, result) },
			commands: [],
			out: null,
		}),
		GotRepoSelectMessage: ({ message: inner }) => {
			const next = Select.update(frame.repoSelect, inner)
			return {
				frame: { ...frame, repoSelect: next.model },
				commands: mapped(next.commands ?? [], (m) =>
					FrameMessage.GotRepoSelectMessage({ message: m }),
				),
				out:
					next.outMessage === undefined
						? null
						: {
								_tag: "PickedRepository",
								repo: isRepositoryId(next.outMessage.value)
									? next.outMessage.value
									: undefined,
							},
			}
		},
		GotOptionSelectMessage: ({ message: inner }) => {
			const next = Select.update(frame.optionSelect, inner)
			return {
				frame: { ...frame, optionSelect: next.model },
				commands: mapped(next.commands ?? [], (m) =>
					FrameMessage.GotOptionSelectMessage({ message: m }),
				),
				out:
					next.outMessage === undefined
						? null
						: {
								_tag: "PickedOption",
								value: next.outMessage.value === ALL ? undefined : next.outMessage.value,
							},
			}
		},
		GotTimePickerMessage: ({ message: inner }) => {
			const next = TimeRangePicker.update(frame.timePicker, inner)
			return {
				frame: { ...frame, timePicker: next.model },
				commands: mapped(next.commands ?? [], (m) =>
					FrameMessage.GotTimePickerMessage({ message: m }),
				),
				out:
					next.outMessage === undefined
						? null
						: next.outMessage._tag === "RejectedRange"
							? { _tag: "RefusedWindow", toast: TimeRangePicker.rejectedToast(next.outMessage.maxRangeSeconds) }
							: { _tag: "PickedWindow", window: TimeRangePicker.searchPatchOf(next.outMessage) },
			}
		},
		ClickedResetTimeRange: () => ({
			frame,
			commands: [],
			out: {
				_tag: "PickedWindow",
				window: { timePreset: defaultPreset, startTime: undefined, endTime: undefined },
			},
		}),
		ClickedReload: () => {
			const next = { ...frame, refreshVersion: frame.refreshVersion + 1, isReloading: true }
			return {
				frame: next,
				commands: [
					resolveCommand(search, defaultPreset, context, "Refresh"),
					CompleteReloadSpin({ version: next.refreshVersion }),
				],
				out: null,
			}
		},
		CompletedReloadSpin: ({ version }) => ({
			frame: version === frame.refreshVersion ? { ...frame, isReloading: false } : frame,
			commands: [],
			out: null,
		}),
	})

/** The repositories the select lists: the installation's, or only those with reviews on. */
export const repositoriesOf = (frame: Frame, reviewedOnly: boolean) =>
	Option.match(AsyncData.getData(frame.githubStatus.data), {
		onNone: () => [],
		onSome: (status) =>
			reviewedOnly ? status.repositories.filter((repo) => repo.prReviewEnabled) : status.repositories,
	})
