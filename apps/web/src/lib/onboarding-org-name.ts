import { Array as Arr, String as Str } from "effect"
// The name `/org-required` fills in: the company in a work email's domain, else the person's own team.

/** Mail providers by company label, so `yahoo.co.uk` and `outlook.de` count as personal too. */
const PERSONAL_EMAIL_PROVIDERS = new Set([
	"gmail",
	"googlemail",
	"outlook",
	"hotmail",
	"live",
	"msn",
	"yahoo",
	"ymail",
	"icloud",
	"me",
	"mac",
	"aol",
	"proton",
	"protonmail",
	"pm",
	"gmx",
	"web",
	"hey",
	"fastmail",
	"zoho",
	"yandex",
	"mail",
	"qq",
	"163",
	"orange",
	"free",
	"laposte",
	"t-online",
])

/** Second-level labels that sit under a country code (`acme.co.uk`), so the company is one further left. */
const SECOND_LEVEL_LABELS = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ne", "or"])

const titleCase = (label: string): string =>
	Arr.join(
		Arr.map(
			Arr.filter(Str.split(/[-_]+/)(label), (word) => word.length > 0),
			(word) => Str.toUpperCase(Str.slice(0, 1)(word)) + Str.slice(1)(word),
		),
		" ",
	)

/** The company label of a domain: `mail.acme.co.uk` and `acme.dev` are both `acme`. */
const companyLabel = (domain: string): string | null => {
	const labels = Arr.filter(Str.split(".")(domain), (label) => label.length > 0)
	if (labels.length < 2) return null
	const topLevel = labels.at(-1) ?? ""
	const underCountryCode =
		labels.length >= 3 && topLevel.length === 2 && SECOND_LEVEL_LABELS.has(labels.at(-2) ?? "")
	return labels.at(underCountryCode ? -3 : -2) ?? null
}

export type SuggestedOrganizationName = Readonly<{
	name: string
	/** The work domain the name came from, shown as the hint; `null` for a personal address. */
	domain: string | null
}>

export const suggestOrganizationName = (
	email: string | null,
	fullName: string | null,
): SuggestedOrganizationName => {
	const domain = email === null ? "" : Str.toLowerCase(Str.trim(Str.split("@")(email)[1] ?? ""))
	const company = companyLabel(domain)
	// Punycode labels (`xn--…`) would read as noise, so they fall back to the person's name.
	const label =
		company === null || PERSONAL_EMAIL_PROVIDERS.has(company) || Str.startsWith("xn--")(company)
			? null
			: company
	if (label !== null && titleCase(label) !== "") return { name: titleCase(label), domain }
	const firstName = fullName === null ? "" : Str.split(/\s+/)(Str.trim(fullName))[0]
	return { name: firstName === "" ? "My team" : `${firstName}'s team`, domain: null }
}
