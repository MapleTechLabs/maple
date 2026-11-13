import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureMessage, type LoadFailure } from "@maple/views/data/load-failure"
import { alert, alertDescription } from "@maple/views/ui/alert"
import { button, linkButton } from "@maple/views/ui/button"
import * as DialogView from "@maple/views/ui/dialog-view"
import { spinner } from "@maple/views/ui/spinner"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"

// A dialog step that works from a connection the org already has: the connection's read, then Back
// beside the step's primary action.

/**
 * A connection step's primary action: a link to where the connection is made or fixed, or a click
 * that acts on the connection the step read.
 */
export type ConnectionStepAction<M> =
	| Readonly<{ label: string; href: string }>
	| Readonly<{ label: string; onClick: M; isLoading?: boolean; isDisabled?: boolean }>

const actionButton = <M>(h: HtmlBuilder<M>, action: ConnectionStepAction<M>): Html =>
	"href" in action
		? linkButton(h, { href: action.href }, [action.label])
		: button(
				h,
				{
					isLoading: action.isLoading ?? false,
					isDisabled: action.isDisabled ?? false,
					attributes: [h.OnClick(action.onClick)],
				},
				[action.label],
			)

/**
 * The step as a dialog's content: its title, the read of the connection (a reading line, a failure
 * with Try again, or what the step makes of the answer) and a footer of Back beside the primary action.
 */
export const connectionStep = <M, A>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		/** The dialog's id, which its title and description are named by. */
		dialogId: string
		title: string
		description: string
		read: AsyncData.AsyncData<A, LoadFailure>
		/** What the step says while the read is out: "Reading the Vercel connection". */
		readingLabel: string
		onRetry: M
		/** What the step shows of the connection it read. */
		content: (data: A) => ReadonlyArray<Html>
		/** The way on from what was read, or null when there is nothing to do but go back. */
		primary: (data: A) => ConnectionStepAction<M> | null
		onBack: M
		/** A write is in flight: Back waits for it. */
		isBusy: boolean
	}>,
): ReadonlyArray<Html> => {
	const primary = AsyncData.matchData(options.read, {
		onEmpty: () => null,
		onFailure: () => null,
		onData: options.primary,
	})
	return [
		DialogView.dialogHeader(h, "dialog", [
			DialogView.dialogTitle(h, "dialog", options.dialogId, options.title),
			DialogView.dialogDescription(h, "dialog", options.dialogId, options.description),
		]),
		DialogView.dialogPanel(h, "dialog", options.dialogId, [
			vstack(
				h,
				{ gap: "3" },
				AsyncData.matchData(options.read, {
					onEmpty: () => [
						hstack(h, { gap: "2" }, [
							spinner(h, undefined, 14, true),
							typography(h, { size: "sm", tone: "muted" }, [options.readingLabel]),
						]),
					],
					onFailure: (failure) => [
						alert(h, { variant: "crit", size: "sm" }, [
							alertDescription(h, [failureMessage(failure)]),
						]),
						hstack(h, {}, [
							button(
								h,
								{
									variant: "outline",
									size: "sm",
									attributes: [h.OnClick(options.onRetry)],
								},
								["Try again"],
							),
						]),
					],
					onData: options.content,
				}),
			),
		]),
		DialogView.dialogFooter(h, "dialog", [
			button(
				h,
				{
					variant: "outline",
					isDisabled: options.isBusy,
					attributes: [h.OnClick(options.onBack)],
				},
				["Back"],
			),
			...(primary === null ? [] : [actionButton(h, primary)]),
		]),
	]
}
