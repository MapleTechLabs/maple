import { Effect, Option, Predicate, Schema, Stream, Array as Arr } from "effect"
import { Mount } from "foldkit"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import type { CrashContext } from "foldkit/runtime"
import { writeClipboardText } from "@maple/ui/lib/clipboard"
import { button, linkButton } from "@maple/views/ui/button"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { heading } from "@maple/views/ui/heading"
import { icon } from "@maple/views/ui/icon"
import { inlineCode } from "@maple/views/ui/inline-code"
import { MAPLE_MARK_PATH } from "@maple/views/ui/icons.generated"
import { mountMapleLeaves } from "./maple-leaves"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"

const MAX_DEPTH = 8

/** The failing Message as `GotPageMessage > StatusPageNew > ElapsedPreviewDebounce`, the tag path the crash span records. */
const tagPath = (value: unknown, depth: number): ReadonlyArray<string> =>
	depth < MAX_DEPTH && Predicate.hasProperty(value, "_tag") && typeof value._tag === "string"
		? [
				value._tag,
				...tagPath(Predicate.hasProperty(value, "message") ? value.message : undefined, depth + 1),
			]
		: []

/** The failing Message as `GotPageMessage > StatusPageNew > ElapsedPreviewDebounce`, the tag path the crash span records. */
export const crashReference = (message: Option.Option<unknown>): string =>
	Option.match(message, {
		onNone: () => "Initial render",
		onSome: (value) => {
			const tags = tagPath(value, 0)
			return tags.length === 0 ? "Unknown message" : Arr.join(tags, " > ")
		},
	})

/** What "Copy details" puts on the clipboard: enough for support to find the crash span. */
export const crashDetails = (
	reference: string,
	at: Readonly<{ pathname: string; time: Date; build: string | undefined }>,
): string =>
	Arr.join(
		[
			`Message: ${reference}`,
			`Page: ${at.pathname}`,
			`Time: ${at.time.toISOString()}`,
			...(at.build === undefined || at.build === "" ? [] : [`Build: ${at.build}`]),
		],
		"\n",
	)

// The dispatch loop is gone, so the leaves and the copy button run on plain DOM listeners.
const MountCrashPage = Mount.defineStream("MountCrashPage", {
	messages: [Schema.Never],
	execute: ({ element }) =>
		Stream.callback<never>(() =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const canvas = element.querySelector("canvas")
					const stopLeaves =
						canvas !== null && element instanceof HTMLElement
							? mountMapleLeaves(canvas, element, { spawnFrom: 0.45 })
							: () => {}
					const onClick = (event: Event) => {
						const target =
							event.target instanceof Element ? event.target.closest("[data-copy]") : null
						if (!(target instanceof HTMLElement)) return
						const label = target.querySelector("[data-copy-label]")
						void writeClipboardText(target.dataset.copy ?? "").then((ok) => {
							if (label !== null) label.textContent = ok ? "Copied" : "Copy failed"
						})
					}
					element.addEventListener("click", onClick)
					return () => {
						stopLeaves()
						element.removeEventListener("click", onClick)
					}
				}),
				(stop) => Effect.sync(stop),
			).pipe(Effect.andThen(Effect.never)),
		),
})

const mapleMark = (h: HtmlBuilder<never>): Html =>
	h.svg(
		[
			h.Attribute("viewBox", "0 0 739 739"),
			h.Attribute("width", "28"),
			h.Attribute("height", "28"),
			h.AriaHidden(true),
			h.Class("text-foreground"),
		],
		[
			h.path([
				h.Attribute("fill-rule", "evenodd"),
				h.Attribute("fill", "currentColor"),
				h.Attribute("d", MAPLE_MARK_PATH),
			]),
		],
	)

/** `crash.view`: replaces the app once the runtime has stopped. Reload and home work without JS from us. */
export const crashView = (context: CrashContext<unknown, unknown>, h: HtmlBuilder<never>): Document => {
	const reference = crashReference(context.message)
	const details = crashDetails(reference, {
		pathname: location.pathname,
		time: new Date(),
		build: import.meta.env.VITE_COMMIT_SHA,
	})
	return {
		title: "Something came loose · Maple",
		body: h.main(
			[
				h.OnMount(MountCrashPage()),
				h.DataAttribute("slot", "crash-page"),
				h.Class(
					"relative isolate flex min-h-screen w-full overflow-hidden bg-background text-foreground",
				),
			],
			[
				h.canvas([
					h.AriaHidden(true),
					h.Class(
						"pointer-events-none absolute inset-0 -z-10 size-full opacity-40 md:opacity-100 md:[mask-image:linear-gradient(90deg,rgb(0_0_0/0.2)_0%,rgb(0_0_0/0.2)_40%,#000_62%)]",
					),
				]),
				vstack(
					h,
					{ gap: "8", justify: "center", className: "w-full max-w-[560px] px-6 py-16 md:px-16" },
					[
						mapleMark(h),
						vstack(h, { gap: "3" }, [
							eyebrow(h, { variant: "label", className: "text-muted-foreground" }, [
								"Unexpected error",
							]),
							heading(h, { level: 1, variant: "display", className: "text-balance" }, [
								"Something came loose",
							]),
							h.p(
								[
									h.Class(
										"max-w-[44ch] font-prose text-base leading-relaxed text-muted-foreground",
									),
								],
								[
									"The dashboard hit an error it could not recover from. Your data and settings are untouched, and a reload usually puts everything back.",
								],
							),
						]),
						hstack(h, { gap: "2", align: "stretch", wrap: true }, [
							button(
								h,
								{
									attributes: [
										h.DataAttribute("crash-gust", ""),
										h.Attribute("onclick", "location.reload()"),
									],
								},
								[icon(h, "ArrowRotateClockwiseIcon"), "Reload"],
							),
							// A plain navigation: Foldkit's link listener would hand the click to the stopped runtime.
							linkButton(
								h,
								{
									variant: "outline",
									href: "/",
									attributes: [
										h.DataAttribute("crash-gust", ""),
										h.Attribute("onclick", "event.stopPropagation()"),
									],
								},
								[icon(h, "HouseIcon"), "Back to home"],
							),
						]),
						vstack(h, { gap: "1.5", className: "max-w-full border-t pt-5" }, [
							typography(h, { size: "xs", tone: "muted", as: "p" }, [
								"If it keeps happening, send us this reference:",
							]),
							hstack(
								h,
								{ align: "center", wrap: true, shrink: true, className: "gap-x-2 gap-y-1" },
								[
									inlineCode(
										h,
										{
											className:
												"min-w-0 rounded-md px-1.5 py-0.5 text-muted-foreground text-xs [overflow-wrap:anywhere] select-all",
										},
										[reference],
									),
									button(
										h,
										{
											variant: "ghost",
											size: "xs",
											className: "shrink-0 text-muted-foreground",
											attributes: [h.DataAttribute("copy", details)],
										},
										[
											icon(h, "CopyIcon"),
											h.span([h.DataAttribute("copy-label", "")], ["Copy details"]),
										],
									),
								],
							),
						]),
					],
				),
			],
		),
	}
}
