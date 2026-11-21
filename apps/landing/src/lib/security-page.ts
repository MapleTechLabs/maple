/**
 * The facts behind `/security` and `/security.md`. Each one points at the docs
 * page or setting that proves it, so a buyer can check it. Audits stay "in
 * progress" until `compliance.ts` says otherwise.
 */
import { DPA_REQUEST_URL } from "./compliance"
import { SUPPORT_EMAIL } from "./agent-resources"

export interface SecurityFact {
	title: string
	body: string
	href?: string
	link?: string
}

export interface SecuritySection {
	id: string
	eyebrow: string
	title: string
	facts: SecurityFact[]
}

export const securitySections: SecuritySection[] = [
	{
		id: "access",
		eyebrow: "Access",
		title: "Who can see what",
		facts: [
			{
				title: "Four roles",
				body: "Admin, Engineer, Member and Analyst. Analysts read everything and build dashboards, and cannot change settings, alerts or keys.",
			},
			{
				title: "SSO and SCIM",
				body: "SAML 2.0 or OIDC sign-in with verified domains and an option to require it. SCIM 2.0 provisions and removes members and maps IdP groups to roles. Both are self-serve add-ons, $100 a month each, on any plan.",
				href: "/docs/reference/single-sign-on",
				link: "SSO and SCIM docs",
			},
			{
				title: "Audit log",
				body: "An append-only log records every action in the dashboard, API and MCP, allowed or denied, and every read of telemetry and session replays. Each entry names the user, API key or agent. Entries are kept for six years.",
				href: "/docs/reference/retention",
				link: "Retention periods",
			},
		],
	},
	{
		id: "data",
		eyebrow: "Data",
		title: "How your data is protected",
		facts: [
			{
				title: "Encrypted in transit and at rest",
				body: "Telemetry reaches Maple over TLS and is stored encrypted.",
			},
			{
				title: "Credentials sealed per row",
				body: "Secrets Maple holds for you, such as OAuth tokens, webhook secrets and warehouse passwords, are sealed with AES-256-GCM. Each one is bound to its organization and row, so a value copied to another row or organization fails to open.",
			},
			{
				title: "Replays mask inputs by default",
				body: "The browser SDK masks every input value before it leaves the browser. One setting masks all rendered text as well.",
				href: "/docs/session-replay/browser-sdk#privacy-and-masking",
				link: "Masking options",
			},
			{
				title: "Retention you can read",
				body: "Hosted Maple deletes data once it passes its retention period, measured from the data's own timestamp. Every period is listed in the docs.",
				href: "/docs/reference/retention",
				link: "Retention periods",
			},
		],
	},
	{
		id: "residency",
		eyebrow: "Residency",
		title: "Where your data lives",
		facts: [
			{
				title: "United States or European Union",
				body: "Each organization picks a region once, when it is created. An EU organization's telemetry is stored and processed in Frankfurt, Germany, at the same price.",
				href: "/eu",
				link: "EU hosting",
			},
			{
				title: "Or your own infrastructure",
				body: "The source is on GitHub under FSL-1.1, which becomes Apache 2.0 after two years. Self-hosting keeps the data inside your own network. The self-hosted version runs for one team; alerting and team accounts are on Cloud.",
				href: "https://github.com/MapleTechLabs/maple",
				link: "Source on GitHub",
			},
		],
	},
]

export const securityFaqs = [
	{
		question: "Is Maple SOC 2 compliant?",
		answer: "Not yet. SOC 2 Type II and ISO 27001 audits are in progress. Until they finish, a data processing agreement is available on request, the audit log is on every plan, and SSO and SCIM are add-ons on any plan.",
	},
	{
		question: "Can I get a DPA?",
		answer: `Yes. Email ${DPA_REQUEST_URL.replace("mailto:", "").split("?")[0]} and ask for the data processing agreement.`,
	},
	{
		question: "Where is my telemetry stored?",
		answer: "In the region your organization chose when it was created: the United States, or the European Union in Frankfurt, Germany. Self-hosted Maple stores it wherever you run it.",
	},
	{
		question: "How do I report a vulnerability?",
		answer: `Email ${SUPPORT_EMAIL} with "Security" in the subject. Include the steps to reproduce it. Please give us time to fix it before you publish.`,
	},
]
