import {
	DEFAULT_STATUS_PAGE_THEME,
	type ResolvedStatusPageTheme,
	resolveStatusPageTheme,
	STATUS_PAGE_HEX_COLOR_PATTERN,
	StatusPageThemeAppearance,
	StatusPageThemeFont,
	StatusPageThemePreset,
	StatusPageThemeRadius,
	type StatusPageTheme,
	type ResolvedStatusPageThemeTokens,
} from "@maple/domain/status-page"
import { Schema } from "effect"
import { safeColor } from "./escape"

const isPreset = Schema.is(StatusPageThemePreset)
const isAppearance = Schema.is(StatusPageThemeAppearance)
const isRadius = Schema.is(StatusPageThemeRadius)
const isFont = Schema.is(StatusPageThemeFont)

const hexOrNull = (value: string | null): string | null =>
	value !== null && STATUS_PAGE_HEX_COLOR_PATTERN.test(value) ? value.toLowerCase() : null

/** The theme with anything outside its schema replaced by the default, so no stray string reaches CSS. */
export const safeTheme = (theme: StatusPageTheme): StatusPageTheme => ({
	preset: isPreset(theme.preset) ? theme.preset : DEFAULT_STATUS_PAGE_THEME.preset,
	appearance: isAppearance(theme.appearance) ? theme.appearance : DEFAULT_STATUS_PAGE_THEME.appearance,
	accent: hexOrNull(theme.accent),
	background: hexOrNull(theme.background),
	text: hexOrNull(theme.text),
	card: hexOrNull(theme.card),
	border: hexOrNull(theme.border),
	radius: isRadius(theme.radius) ? theme.radius : DEFAULT_STATUS_PAGE_THEME.radius,
	font: isFont(theme.font) ? theme.font : DEFAULT_STATUS_PAGE_THEME.font,
})

export const resolveSafeTheme = (theme: StatusPageTheme): ResolvedStatusPageTheme =>
	resolveStatusPageTheme(safeTheme(theme))

const TOKEN_NAMES = [
	"bg",
	"fg",
	"muted",
	"line",
	"card",
	"link",
	"secondary",
	"ok",
	"degraded",
	"partial",
	"major",
	"maint",
	"none",
	"okTint",
	"degradedTint",
	"partialTint",
	"majorTint",
	"maintTint",
] as const satisfies ReadonlyArray<keyof ResolvedStatusPageThemeTokens>

/** `okTint` as `ok-tint`. */
const cssName = (name: string): string => name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)

/** One scheme's CSS variables; `safeColor` drops any token that is not a hex colour. */
export const tokenVariables = (tokens: ResolvedStatusPageThemeTokens): string =>
	TOKEN_NAMES.flatMap((name) => {
		const value = safeColor(tokens[name])
		return value === null ? [] : [`--${cssName(name)}:${value}`]
	}).join(";")
