/**
 * Runtime renderers for status page subscriber emails: the confirmation and the update.
 *
 * The markup lives in `templates/` and is compiled to `src/generated/status-page-*.ts`
 * (`bun run --cwd packages/email build`). This module only splices those strings together.
 */
import { PAGE as CONFIRM_PAGE } from "./generated/status-page-confirm"
import { FRAGMENTS, PAGE as UPDATE_PAGE } from "./generated/status-page-update"
import { escapeHtml } from "@maple/strings"
import { fill, preheaderPadding, truncate } from "./template"
import { Array as Arr, String as Str } from "effect"

export interface StatusPageConfirmEmailProps {
	pageName: string
	/** What the subscription covers, e.g. "all components" or "API, Dashboard". */
	scope: string
	confirmUrl: string
	/** e.g. "48 hours". */
	expiresIn: string
}

export function renderStatusPageConfirmEmail(props: StatusPageConfirmEmailProps): string {
	const previewText = `Confirm your subscription to ${props.pageName} status updates`
	return fill(
		CONFIRM_PAGE,
		{
			previewText,
			pageName: truncate(props.pageName, 80),
			scope: props.scope,
			confirmUrl: props.confirmUrl,
			expiresIn: props.expiresIn,
		},
		{ preheaderPad: escapeHtml(preheaderPadding(previewText)) },
	)
}

/** All values pre-formatted; the body is the update's text, split into paragraphs on blank lines. */
export interface StatusPageUpdateEmailProps {
	pageName: string
	/** "Incident" or "Maintenance". */
	kindLabel: string
	/** e.g. "Investigating", "Resolved". */
	statusLabel: string
	title: string
	body: string
	/** Affected components, or a phrase for all of them. */
	affected: string
	postedAt: string
	/** Hex accent for the status, e.g. "#e01e5a". */
	accentColor: string
	pageUrl: string
	unsubscribeUrl: string
}

export function renderStatusPageUpdateEmail(props: StatusPageUpdateEmailProps): string {
	const previewText = `${props.statusLabel}: ${props.title}`
	const bodyParagraphs = Arr.join(
		Arr.map(
			Arr.filter(Str.split(/\n\s*\n/u)(Str.trim(props.body)), (part) => part !== ""),
			(text) => fill(FRAGMENTS.paragraph, { text }),
		),
		"",
	)
	return fill(
		UPDATE_PAGE,
		{
			previewText,
			pageName: truncate(props.pageName, 80),
			kindLabel: props.kindLabel,
			accentColor: props.accentColor,
			statusLabel: props.statusLabel,
			title: truncate(props.title, 120),
			affected: props.affected,
			postedAt: props.postedAt,
			pageUrl: props.pageUrl,
			unsubscribeUrl: props.unsubscribeUrl,
		},
		{ preheaderPad: escapeHtml(preheaderPadding(previewText)), bodyParagraphs },
	)
}
