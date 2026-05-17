import { useMemo, useState } from "react"
import { Exit } from "effect"
import { SetServiceRepoRequest } from "@maple/domain/http"
import { NativeSelect, NativeSelectOption } from "@maple/ui/components/ui/native-select"
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@maple/ui/components/ui/table"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { toast } from "sonner"

import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

const SERVICE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

function repoKey(owner: string, name: string): string {
	return `${owner}/${name}`
}

export function GithubServiceRepos() {
	const timeRange = useMemo(() => {
		const now = Date.now()
		return {
			startTime: new Date(now - SERVICE_WINDOW_MS).toISOString(),
			endTime: new Date(now).toISOString(),
		}
	}, [])

	const servicesResult = useAtomValue(
		MapleApiAtomClient.query("observability", "listServices", {
			payload: { timeRange },
		}),
	)
	const mappingsResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "githubServiceRepos", {
			reactivityKeys: ["githubServiceRepoMappings"],
		}),
	)
	const reposResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "githubRepos", {}),
	)

	const setServiceRepo = useAtomSet(
		MapleApiAtomClient.mutation("integrations", "githubSetServiceRepo"),
		{ mode: "promiseExit" },
	)
	const deleteServiceRepo = useAtomSet(
		MapleApiAtomClient.mutation("integrations", "githubDeleteServiceRepo"),
		{ mode: "promiseExit" },
	)

	const [pending, setPending] = useState<string | null>(null)

	const mappings = Result.builder(mappingsResult)
		.onSuccess((r) => r.mappings)
		.orElse(() => [])
	const repos = Result.builder(reposResult)
		.onSuccess((r) => r.repos)
		.orElse(() => [])
	const services = Result.builder(servicesResult)
		.onSuccess((r) => r.services.map((s) => s.name))
		.orElse(() => [])

	const reposLoading = Result.isInitial(reposResult)
	const reposError = Result.builder(reposResult)
		.onError(() => true)
		.orElse(() => false)

	const mappingByService = useMemo(() => {
		const map = new Map<string, { repoOwner: string; repoName: string }>()
		for (const m of mappings) {
			map.set(m.serviceName, { repoOwner: m.repoOwner, repoName: m.repoName })
		}
		return map
	}, [mappings])

	const rows = useMemo(() => {
		const names = new Set<string>(services)
		for (const m of mappings) names.add(m.serviceName)
		return [...names].sort((a, b) => a.localeCompare(b))
	}, [services, mappings])

	async function handleChange(serviceName: string, value: string) {
		setPending(serviceName)
		if (value === "") {
			const result = await deleteServiceRepo({
				params: { serviceName },
				reactivityKeys: ["githubServiceRepoMappings"],
			})
			setPending(null)
			if (Exit.isSuccess(result)) {
				toast.success(`Unlinked ${serviceName}`)
			} else {
				toast.error(`Failed to unlink ${serviceName}`)
			}
			return
		}
		const repo = repos.find((r) => repoKey(r.owner, r.name) === value)
		if (!repo) {
			setPending(null)
			return
		}
		const result = await setServiceRepo({
			payload: new SetServiceRepoRequest({
				serviceName,
				repoOwner: repo.owner,
				repoName: repo.name,
			}),
			reactivityKeys: ["githubServiceRepoMappings"],
		})
		setPending(null)
		if (Exit.isSuccess(result)) {
			toast.success(`Linked ${serviceName} to ${repo.fullName}`)
		} else {
			toast.error(`Failed to link ${serviceName}`)
		}
	}

	if (Result.isInitial(mappingsResult) || Result.isInitial(servicesResult)) {
		return (
			<div className="space-y-2">
				<Skeleton className="h-8 w-full" />
				<Skeleton className="h-8 w-full" />
				<Skeleton className="h-8 w-full" />
			</div>
		)
	}

	return (
		<div className="space-y-2">
			<div className="text-xs font-medium text-foreground">Service repositories</div>
			<p className="text-[11px] text-muted-foreground">
				Map each service to a GitHub repository. Commit SHAs on traces from that service
				become clickable links.
			</p>
			{reposError ? (
				<p className="text-[11px] text-severity-error">
					Could not load your GitHub repositories. Try reconnecting the integration.
				</p>
			) : null}
			{rows.length === 0 ? (
				<p className="text-[11px] text-muted-foreground">
					No services have reported telemetry in the last 30 days.
				</p>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead className="text-xs">Service</TableHead>
							<TableHead className="text-xs">Repository</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((serviceName) => {
							const current = mappingByService.get(serviceName)
							const currentValue = current
								? repoKey(current.repoOwner, current.repoName)
								: ""
							return (
								<TableRow key={serviceName}>
									<TableCell className="font-mono text-xs">{serviceName}</TableCell>
									<TableCell>
										<NativeSelect
											size="sm"
											className="w-full"
											value={currentValue}
											disabled={pending === serviceName || reposLoading}
											onChange={(e) => handleChange(serviceName, e.target.value)}
										>
											<NativeSelectOption value="">
												{reposLoading ? "Loading repositories…" : "— Not linked —"}
											</NativeSelectOption>
											{current &&
											!repos.some(
												(r) => repoKey(r.owner, r.name) === currentValue,
											) ? (
												<NativeSelectOption value={currentValue}>
													{currentValue}
												</NativeSelectOption>
											) : null}
											{repos.map((repo) => (
												<NativeSelectOption
													key={repo.fullName}
													value={repoKey(repo.owner, repo.name)}
												>
													{repo.fullName}
													{repo.private ? " (private)" : ""}
												</NativeSelectOption>
											))}
										</NativeSelect>
									</TableCell>
								</TableRow>
							)
						})}
					</TableBody>
				</Table>
			)}
		</div>
	)
}
