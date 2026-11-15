import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import {
	profileSummary,
	topFunctionsTable,
	view as flamegraphView,
} from "@maple/views/profiles/profile-flamegraph-view"
import {
	empty,
	emptyContent,
	emptyDescription,
	emptyFrameClass,
	emptyHeader,
	emptyMedia,
	emptyTitle,
} from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { heading } from "@maple/views/ui/heading"
import { icon } from "@maple/views/ui/icon"
import { inlineCode } from "@maple/views/ui/inline-code"
import { skeleton, skeletonBlock } from "@maple/views/ui/skeleton"
import { hstack, vstack, vstackClass } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { codeBlock } from "../../kit/code-block"
import { Message } from "./message"
import type { Model, ServiceProfile } from "./model"

// The Profiles tab: where the service spent CPU in the window, as a flame chart and the functions
// that used the most. A service that sent no profiles gets the setting that turns profiling on.

type H = HtmlBuilder<Message>
type Profile = NonNullable<ServiceProfile>

const TOP_FUNCTIONS = 15

/** Rows of stack the tab's flame chart shows before it scrolls. */
export const PROFILE_CHART_ROWS = 22

/** The setting that turns profiling on, as the empty state shows it. */
export const PROFILING_SNIPPET = `import { Maple } from "@maple-dev/effect-sdk/server"

Maple.layer({ serviceName: "my-service", profiling: true })`

const loadingState = (h: H): Html =>
	vstack(h, { gap: "3", attributes: [h.AriaBusy(true), h.AriaLabel("Loading the profile")] }, [
		hstack(h, { align: "center", justify: "between", gap: "3" }, [
			skeleton(h, "h-4 w-28"),
			skeleton(h, "h-3 w-64"),
		]),
		skeletonBlock(h, { height: "48" }),
		skeleton(h, "h-4 w-28"),
		skeletonBlock(h, { height: "48" }),
	])

/** No profiles in the window: what the tab will show, and the one setting that sends them. */
const emptyState = (h: H, model: Model): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "FireIcon")]),
				emptyTitle(h, ["No profiles in this window"]),
				emptyDescription(h, [
					"Continuous profiling samples the CPU while this service runs and shows the functions it spent the time in.",
				]),
			]),
			emptyContent(
				h,
				[
					typography(h, { size: "sm", tone: "muted", as: "p" }, [
						"Turn it on where the service builds its telemetry layer, with ",
						inlineCode(h, {}, ["profiling: true"]),
						". It runs on Node and Bun.",
					]),
					codeBlock(h, {
						code: PROFILING_SNIPPET,
						language: "telemetry.ts",
						lang: "ts",
						className: "w-full text-left",
						copy: model.profileSnippetCopy,
						toCopyMessage: (message) => Message.GotProfileSnippetCopyMessage({ message }),
					}),
				],
				"max-w-xl",
			),
		],
		emptyFrameClass("solid"),
	)

const loaded = (h: H, model: Model, profile: Profile, isWaiting: boolean): Html => {
	const input = { stacks: profile.stacks, totalValue: profile.totalValue }
	return h.section(
		[
			h.Class(cn(vstackClass({ gap: "3" }), refreshingClass(isWaiting))),
			...(isWaiting ? [h.AriaBusy(true)] : []),
		],
		[
			hstack(h, { align: "baseline", justify: "between", gap: "3", wrap: true }, [
				heading(h, { level: 2, variant: "subsection" }, [`Profile: ${profile.sampleType}`]),
				typography(h, { size: "xs", tone: "muted", numeric: true }, [profileSummary(profile)]),
			]),
			flamegraphView(
				h,
				model.flamegraph,
				{ input, unit: profile.sampleUnit, maxRows: PROFILE_CHART_ROWS },
				(message) => Message.GotFlamegraphMessage({ message }),
			),
			heading(h, { level: 2, variant: "subsection" }, ["Top functions"]),
			topFunctionsTable(h, input, {
				unit: profile.sampleUnit,
				limit: TOP_FUNCTIONS,
				scope: model.flamegraph.scope,
			}),
		],
	)
}

const body = (h: H, model: Model, profile: ServiceProfile, isWaiting: boolean): Html =>
	profile === null ? emptyState(h, model) : loaded(h, model, profile, isWaiting)

/** The Profiles tab: skeleton, error (first read only), the setup state, or the chart and table. */
export const profilesTab = (h: H, model: Model): Html =>
	AsyncData.match(model.profile.data, {
		onIdle: () => loadingState(h),
		onLoading: () => loadingState(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load the profile",
				onRetry: Message.ClickedRetry({ target: "Profile" }),
			}),
		// A failed reload keeps the last profile on screen.
		onStale: ({ data }) => body(h, model, data, false),
		onRefreshing: (profile) => body(h, model, profile, true),
		onSuccess: (profile) => body(h, model, profile, false),
	})
