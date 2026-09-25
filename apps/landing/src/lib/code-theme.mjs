// @ts-check
import vitesseDark from "@shikijs/themes/vitesse-dark"

// vitesse-dark renders punctuation, comments and quote marks below WCAG AA (2.3-3.9:1 on its
// #121212 background). Lift just those tokens to >= 5:1 and keep them quieter than code text.
/** @type {Record<string, string>} */
const replacements = {
	"#666666": "#858585",
	"#758575dd": "#8b9b8b",
	"#c98a7d77": "#c98a7d",
	"#b8a96577": "#b8a965",
}

export const codeTheme = {
	...vitesseDark,
	name: "maple-vitesse-dark",
	tokenColors: vitesseDark.tokenColors?.map((token) => {
		const fg = token.settings.foreground?.toLowerCase()
		return fg && fg in replacements
			? { ...token, settings: { ...token.settings, foreground: replacements[fg] } }
			: token
	}),
}
