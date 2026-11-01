import { DependencyFindingId, DependencyScanId } from "@maple/domain/dependency-scan"
import {
	type DependencyFindingsResponse,
	type DependencyFindingView,
	type DependencyScanRepositoriesResponse,
	type DependencyScanRepository,
	GitCommitSha,
	VcsRepositoryId,
} from "@maple/domain/http"
import { Schema } from "effect"

// Fixtures for the Security Center's Dependencies tab, for `/lab/security` and the page's scene
// tests. Built relative to `now` so relative times read the same.

const HOUR = 3_600_000
const DAY = 24 * HOUR

const repositoryId = Schema.decodeSync(VcsRepositoryId)
const scanId = Schema.decodeSync(DependencyScanId)
const findingId = Schema.decodeSync(DependencyFindingId)
const sha = Schema.decodeSync(GitCommitSha)

export const REPOSITORY_IDS = {
	payments: repositoryId("6f1c2d3e-4a5b-4c6d-8e7f-901a2b3c4d5e"),
	web: repositoryId("7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"),
	cli: repositoryId("8b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e"),
} as const

const SCAN_IDS = {
	payments: scanId("1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"),
	web: scanId("2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e"),
	cli: scanId("3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f"),
	older: scanId("4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f8a"),
} as const

const SHAS = {
	payments: sha("4e1d9c2a7b3f8e6d5c4b3a2918f7e6d5c4b3a291"),
	web: sha("9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b"),
	cli: sha("c0ffee1234567890abcdef1234567890abcdef12"),
	older: sha("0123456789abcdef0123456789abcdef01234567"),
} as const

export const PAYMENTS_ID = REPOSITORY_IDS.payments

const service = (serviceName: string, commitSha: GitCommitSha, spanCount: number) => ({
	serviceName,
	environment: "production",
	commitSha,
	spanCount,
})

/** What production ran over the last day: payments-api and web are deployed, cli is not. */
const RUNNING = {
	payments: [
		service("api-gateway", SHAS.payments, 2_400_000),
		service("payments-worker", SHAS.payments, 180_000),
	],
	web: [service("web-frontend", SHAS.web, 640_000)],
} as const

const payments = (nowMs: number): DependencyScanRepository => ({
	id: REPOSITORY_IDS.payments,
	fullName: "acme/payments-api",
	htmlUrl: "https://github.com/acme/payments-api",
	runningCommits: [{ commitSha: SHAS.payments, scanStatus: "completed", services: RUNNING.payments }],
	trackedBranch: "main",
	latestScan: {
		id: SCAN_IDS.payments,
		commitSha: SHAS.payments,
		ref: "refs/heads/main",
		trigger: "push",
		status: "completed",
		lockfiles: [
			{
				path: "pnpm-lock.yaml",
				kind: "pnpm-lock",
				blobSha: "a1",
				packageCount: 1184,
				status: "parsed",
				message: null,
			},
			{
				path: "services/ledger/go.sum",
				kind: "go-sum",
				blobSha: "a2",
				packageCount: 96,
				status: "parsed",
				message: null,
			},
			{
				path: "tools/migrate/Cargo.lock",
				kind: "cargo-lock",
				blobSha: "a3",
				packageCount: 0,
				status: "failed",
				message: "Line 212: expected a [[package]] table.",
			},
		],
		packageCount: 1280,
		vulnerableCount: 5,
		error: null,
		startedAt: nowMs - 2 * HOUR - 40_000,
		finishedAt: nowMs - 2 * HOUR,
	},
})

const web = (nowMs: number): DependencyScanRepository => ({
	id: REPOSITORY_IDS.web,
	fullName: "acme/web",
	htmlUrl: "https://github.com/acme/web",
	runningCommits: [{ commitSha: SHAS.web, scanStatus: "completed", services: RUNNING.web }],
	trackedBranch: "main",
	latestScan: {
		id: SCAN_IDS.web,
		commitSha: SHAS.web,
		ref: "refs/heads/main",
		trigger: "push",
		status: "completed",
		lockfiles: [
			{
				path: "bun.lockb",
				kind: "bun-lockb",
				blobSha: "b1",
				packageCount: 0,
				status: "unsupported",
				message:
					"Binary bun.lockb is not readable. Run `bun install --save-text-lockfile` and commit bun.lock.",
			},
			{
				path: "docs/package-lock.json",
				kind: "package-lock",
				blobSha: "b2",
				packageCount: 412,
				status: "parsed",
				message: null,
			},
		],
		packageCount: 412,
		vulnerableCount: 2,
		error: null,
		startedAt: nowMs - DAY - 30_000,
		finishedAt: nowMs - DAY,
	},
})

const cli = (nowMs: number): DependencyScanRepository => ({
	id: REPOSITORY_IDS.cli,
	fullName: "acme/cli",
	htmlUrl: "https://github.com/acme/cli",
	runningCommits: [],
	trackedBranch: "release",
	latestScan: {
		id: SCAN_IDS.cli,
		commitSha: SHAS.cli,
		ref: "refs/heads/release",
		trigger: "schedule",
		status: "completed",
		lockfiles: [
			{
				path: "Cargo.lock",
				kind: "cargo-lock",
				blobSha: "c1",
				packageCount: 214,
				status: "parsed",
				message: null,
			},
		],
		packageCount: 214,
		vulnerableCount: 1,
		error: null,
		startedAt: nowMs - 3 * DAY - 20_000,
		finishedAt: nowMs - 3 * DAY,
	},
})

export const repositoriesOf = (nowMs: number): DependencyScanRepositoriesResponse => ({
	repositories: [payments(nowMs), web(nowMs), cli(nowMs)],
})

/** Connected, before the repository's first scan. */
/** The same repositories with every lockfile read, as the clean state requires. */
export const cleanRepositoriesOf = (nowMs: number): DependencyScanRepositoriesResponse => ({
	repositories: repositoriesOf(nowMs).repositories.map((repository) =>
		repository.latestScan === null
			? repository
			: {
					...repository,
					latestScan: {
						...repository.latestScan,
						lockfiles: repository.latestScan.lockfiles.map((lockfile) => ({
							...lockfile,
							status: "parsed" as const,
							message: null,
						})),
					},
				},
	),
})

export const neverScannedOf = (nowMs: number): DependencyScanRepositoriesResponse => ({
	repositories: [{ ...payments(nowMs), latestScan: null }],
})

export const noRepositories: DependencyScanRepositoriesResponse = { repositories: [] }

/** The payments repository scanned once more, later, as a completed Scan now would leave it. */
export const rescannedOf = (nowMs: number): DependencyScanRepositoriesResponse => {
	const [first, ...rest] = repositoriesOf(nowMs).repositories
	return first === undefined || first.latestScan === null
		? repositoriesOf(nowMs)
		: {
				repositories: [
					{
						...first,
						latestScan: {
							...first.latestScan,
							id: SCAN_IDS.older,
							commitSha: SHAS.older,
							finishedAt: nowMs,
						},
					},
					...rest,
				],
			}
}

export const FINDING_IDS = {
	axios: findingId("0a1b2c3d4e5f60718293a4b5c6d7e8f9"),
	xnet: findingId("1b2c3d4e5f60718293a4b5c6d7e8f90a"),
	vite: findingId("2c3d4e5f60718293a4b5c6d7e8f90a1b"),
	tokio: findingId("3d4e5f60718293a4b5c6d7e8f90a1b2c"),
	marked: findingId("4e5f60718293a4b5c6d7e8f90a1b2c3d"),
	lodash: findingId("5f60718293a4b5c6d7e8f90a1b2c3d4e"),
	jwt: findingId("60718293a4b5c6d7e8f90a1b2c3d4e5f"),
} as const

type FindingSeed = Pick<
	DependencyFindingView,
	| "id"
	| "repositoryId"
	| "repositoryFullName"
	| "lockfilePath"
	| "ecosystem"
	| "packageName"
	| "advisoryId"
	| "aliases"
	| "severity"
	| "summary"
	| "versions"
	| "fixedIn"
	| "relation"
>

const finding = (
	nowMs: number,
	seed: FindingSeed,
	firstSeenAgoMs: number,
	production: DependencyFindingView["production"] = [],
): DependencyFindingView => {
	const scan =
		seed.repositoryId === REPOSITORY_IDS.payments
			? "payments"
			: seed.repositoryId === REPOSITORY_IDS.web
				? "web"
				: "cli"
	return {
		...seed,
		status: "open",
		firstSeenScanId: SCAN_IDS.older,
		lastSeenScanId: SCAN_IDS[scan],
		firstSeenSha: SHAS.older,
		lastSeenSha: SHAS[scan],
		fixedScanId: null,
		fixedSha: null,
		statusReason: null,
		statusChangedBy: null,
		statusChangedAt: null,
		createdAt: nowMs - firstSeenAgoMs,
		updatedAt: nowMs - 2 * HOUR,
		production,
	}
}

const PAYMENTS = { repositoryId: REPOSITORY_IDS.payments, repositoryFullName: "acme/payments-api" } as const
const WEB = { repositoryId: REPOSITORY_IDS.web, repositoryFullName: "acme/web" } as const
const CLI = { repositoryId: REPOSITORY_IDS.cli, repositoryFullName: "acme/cli" } as const

/** Worst first, as the server sorts them: one per severity, a dismissed and a fixed finding. */
export const findingsOf = (nowMs: number): DependencyFindingsResponse => ({
	production: { available: true, runningServices: 4, linkedServices: 3, complete: true },
	findings: [
		finding(
			nowMs,
			{
				...PAYMENTS,
				id: FINDING_IDS.axios,
				lockfilePath: "pnpm-lock.yaml",
				ecosystem: "npm",
				packageName: "axios",
				advisoryId: "GHSA-jr5f-v2jv-69x6",
				aliases: ["CVE-2025-27152"],
				severity: "critical",
				summary:
					"axios requests to absolute URLs ignore baseURL, so a crafted URL can leak credentials to another host.",
				versions: ["1.7.4"],
				fixedIn: "1.8.2",
				relation: "direct",
			},
			9 * DAY,
			RUNNING.payments,
		),
		finding(
			nowMs,
			{
				...PAYMENTS,
				id: FINDING_IDS.xnet,
				lockfilePath: "services/ledger/go.sum",
				ecosystem: "Go",
				packageName: "golang.org/x/net",
				advisoryId: "GO-2025-3503",
				aliases: ["CVE-2025-22870", "GHSA-qxp5-gwg8-xv66"],
				severity: "high",
				summary: "HTTP proxy bypass using IPv6 zone IDs.",
				versions: ["0.33.0"],
				fixedIn: "0.36.0",
				relation: "transitive",
			},
			4 * DAY,
			[RUNNING.payments[1]],
		),
		finding(
			nowMs,
			{
				...PAYMENTS,
				id: FINDING_IDS.vite,
				lockfilePath: "pnpm-lock.yaml",
				ecosystem: "npm",
				packageName: "vite",
				advisoryId: "GHSA-vg6x-rcgg-rjx6",
				aliases: ["CVE-2025-24010"],
				severity: "medium",
				summary:
					"Websites were able to send any requests to the development server and read the response.",
				versions: ["5.4.10", "6.0.7"],
				fixedIn: "6.0.9",
				relation: "dev",
			},
			2 * DAY,
		),
		finding(
			nowMs,
			{
				...CLI,
				id: FINDING_IDS.tokio,
				lockfilePath: "Cargo.lock",
				ecosystem: "crates.io",
				packageName: "tokio",
				advisoryId: "RUSTSEC-2025-0023",
				aliases: ["GHSA-rr8g-9fpq-6wmg"],
				severity: "low",
				summary: "Broadcast channel calls clone in parallel, but does not require Sync.",
				versions: ["1.38.0"],
				fixedIn: "1.38.2",
				relation: "transitive",
			},
			20 * DAY,
		),
		finding(
			nowMs,
			{
				...WEB,
				id: FINDING_IDS.marked,
				lockfilePath: "docs/package-lock.json",
				ecosystem: "npm",
				packageName: "marked",
				advisoryId: "GHSA-4r62-v4vq-hr96",
				aliases: [],
				severity: "unknown",
				summary: null,
				versions: ["4.0.9"],
				fixedIn: null,
				relation: "unknown",
			},
			DAY,
		),
		{
			...finding(
				nowMs,
				{
					...WEB,
					id: FINDING_IDS.lodash,
					lockfilePath: "docs/package-lock.json",
					ecosystem: "npm",
					packageName: "lodash.template",
					advisoryId: "GHSA-35jh-r3h4-6jhm",
					aliases: ["CVE-2021-23337"],
					severity: "high",
					summary: "Command injection in lodash template.",
					versions: ["4.5.0"],
					fixedIn: null,
					relation: "dev",
				},
				30 * DAY,
			),
			status: "dismissed",
			statusReason: "Only used by the docs build, never with user input.",
			statusChangedAt: nowMs - 6 * DAY,
		},
		{
			...finding(
				nowMs,
				{
					...PAYMENTS,
					id: FINDING_IDS.jwt,
					lockfilePath: "pnpm-lock.yaml",
					ecosystem: "npm",
					packageName: "jsonwebtoken",
					advisoryId: "GHSA-8cf7-32gw-wr33",
					aliases: ["CVE-2022-23539"],
					severity: "high",
					summary: "Insecure key types can be used for signature verification.",
					versions: ["8.5.1"],
					fixedIn: "9.0.0",
					relation: "direct",
				},
				40 * DAY,
			),
			status: "fixed",
			fixedScanId: SCAN_IDS.payments,
			fixedSha: SHAS.payments,
		},
	],
})

export const noFindings: DependencyFindingsResponse = {
	findings: [],
	production: { available: true, runningServices: 3, linkedServices: 3, complete: true },
}
