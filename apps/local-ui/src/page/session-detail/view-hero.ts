import { formatUtcTitle } from "../../lib/time"
import { formatDateTime, type TimeFormat } from "../kit/local-time"
import { isLocalSessionLive, localSessionDurationMs } from "../../lib/session-liveness"
import { initialsFrom } from "@maple/ui/lib/initials"
import { gradientFor, isMobileDevice } from "@maple/ui/lib/replay"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { formatRelativeFrom } from "@maple/ui/lib/time-format"
import * as CopyButton from "@maple/views/ui/copy-button"
import { heading } from "@maple/views/ui/heading"
import { icon } from "@maple/views/ui/icon"
import { hstack } from "@maple/views/ui/stack"
import { truncatedId } from "@maple/views/ui/truncated-id"
import { DateTime } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { copyOf } from "../kit/copies"
import { Message } from "./message"
import type { Model, SessionDetail } from "./model"
import { statTile, statusBadge } from "./view-bits"

// The hero and stat tiles of `SessionDetailView`.

export const SESSION_ID_COPY = "session-id"

export const hero = (h: HtmlBuilder<Message>, model: Model, session: SessionDetail, label: string, timeFormat: TimeFormat): Html => {
	const copy = copyOf(model.copies, SESSION_ID_COPY)
	return hstack(
		h,
		{ gap: "4", wrap: true, className: "border-b pb-5" },
		[
			h.div(
				[
					h.Class(
						`grid size-12 shrink-0 place-items-center rounded-full bg-gradient-to-br ${gradientFor(model.sessionId)} text-base font-semibold text-white shadow-raised`,
					),
				],
				[initialsFrom(label)],
			),
			h.div(
				[h.Class("min-w-0 flex-1")],
				[
					hstack(h, { gap: "2" }, [
						heading(h, { level: 1, variant: "title", className: "truncate" }, [label]),
						statusBadge(h, isLocalSessionLive(session, model.nowMs)),
					]),
					hstack(
						h,
						{ gap: "3", wrap: true, className: "mt-1 text-sm text-muted-foreground" },
						[
							truncatedId(h, {
								value: model.sessionId,
								kind: "session",
								length: 8,
								className: "text-xs",
								copy: {
									status: copy.status,
									onClick: Message.GotCopyMessage({ id: SESSION_ID_COPY, message: CopyButton.Message.ClickedCopy({ text: model.sessionId }) }),
								},
							}),
							hstack(h, { as: "span", inline: true, gap: "1.5" }, [
								icon(h, isMobileDevice(session.deviceType) ? "MobileIcon" : "ComputerIcon", { className: "size-3.5" }),
								session.browserName || "Unknown",
								...(session.osName ? [` · ${session.osName}`] : []),
							]),
							hstack(
								h,
								{
									as: "span",
									inline: true,
									gap: "1.5",
									attributes: [h.Title(`${formatDateTime(timeFormat, session.startTime)} (${formatUtcTitle(session.startTime)})`)],
								},
								[
									icon(h, "ClockIcon", { className: "size-3.5" }),
									"started ",
									formatRelativeFrom(DateTime.toEpochMillis(session.startTime), model.nowMs),
								],
							),
						],
					),
				],
			),
		],
	)
}

export const statTiles = <M>(h: HtmlBuilder<M>, session: SessionDetail): Html =>
	h.div(
		[h.Class("mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5")],
		[
			statTile(h, "Duration", formatSessionDuration(localSessionDurationMs(session))),
			statTile(h, "Page views", String(session.pageViews)),
			statTile(h, "Clicks", String(session.clickCount)),
			statTile(h, "Errors", String(session.errorCount), session.errorCount > 0),
			statTile(h, "Traces", String(session.traceIds.length)),
		],
	)
