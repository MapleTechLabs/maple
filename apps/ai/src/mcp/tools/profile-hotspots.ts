import { McpInvalidInputError, McpQueryBudgetError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../tenant"
import { MCP_SEARCH_MAX_HOURS } from "../lib/time"
import { percentOf, tableCell } from "../lib/format"
import { formatBytes } from "../lib/infra-render"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { Array as Arr, Effect, Result, Schema } from "effect"
import { formatDuration, formatNumber } from "@maple/domain/format"
import { topFunctions } from "@maple/domain/profiles"
import { ProfileSampleTypesRequest, ProfileStacksRequest } from "@maple/domain/http"
import { makeProfileReads } from "@maple/backend/queries/profile-reads"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"

const WINDOW = P.timeWindow({ defaultHours: 1, maxHours: MCP_SEARCH_MAX_HOURS })

/** The sample type read when none is asked for: CPU is what "where does the time go" means. */
const DEFAULT_SAMPLE_TYPE = "cpu"

/** A sampled value in its unit: CPU nanoseconds as a duration, allocations as bytes. */
const formatProfileValue = (unit: string, value: number): string =>
	unit === "nanoseconds"
		? formatDuration(value / 1_000_000)
		: unit === "bytes"
			? formatBytes(value)
			: formatNumber(value)

/** `catchTags` handlers for the profile reads: a timeout is a budget error, a refusal bad input. */
const readHandlers = (pipe: string) => ({
	"@maple/http/errors/QueryEngineTimeoutError": () =>
		Effect.fail(
			new McpQueryBudgetError({
				message: "The profile read ran past its time limit. Narrow start_time/end_time.",
				pipeName: pipe,
				setting: "max_execution_time",
			}),
		),
	// A stacks read too large to return even at the smaller cap: a shorter window fixes it.
	"@maple/http/errors/QueryEngineValidationError": (error: { readonly message: string }) =>
		Effect.fail(new McpInvalidInputError({ message: error.message, parameter: "start_time" })),
	...warehouseReadToMcpHandlers(pipe),
})

/**
 * Average cores over the profiled windows, for `cpu` over a whole service only: a trace's samples
 * are a slice of windows that `durationNano` counts whole.
 */
const averageCores = (
	row: { sampleType: string; sampleUnit: string; value: number; durationNano: number },
	traceScoped: boolean,
) =>
	!traceScoped && row.sampleType === "cpu" && row.sampleUnit === "nanoseconds" && row.durationNano > 0
		? row.value / row.durationNano
		: undefined

export function registerProfileHotspotsTool(server: McpToolRegistrar) {
	server.define({
		name: "profile_hotspots",
		title: "Profile Hotspots",
		description:
			"Where a service spent its CPU (or allocated memory), from continuous profiling: functions ranked by their own time (`self`), with the time including everything they called (`total`) alongside. " +
			"Pass `trace_id` to read only the samples linked to that trace's spans (e.g. a slow trace from find_slow_traces), with start_time/end_time around the trace: the default window is the last hour. " +
			"Also lists the sample types the service sent (cpu, wall, alloc_space, ...). Empty when the service does not run a profiler.",
		parameters: Schema.Struct({
			service: P.text("The service (exact `service.name`)"),
			trace_id: P.optionalText("Only the samples linked to this trace's spans"),
			sample_type: P.optionalText(
				"Sample type to read (e.g. cpu, wall, alloc_space). Default: cpu, else the first type the service sent",
			),
			environment: P.environment(),
			...WINDOW.fields,
			limit: P.limit({ default: 20, max: 100, noun: "functions" }),
		}),
		aliases: P.SERVICE_ALIASES,
		hints: { readOnly: true },
		permission: "telemetry:read",
		phrases: ["Reading profiles", "Finding hot functions"],
		handler: Effect.fn("McpTool.profileHotspots")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, "profile_hotspots")
			const tenant = yield* CurrentMcpTenant
			const reads = makeProfileReads({
				warehouse: yield* WarehouseQueryService,
				queryEngine: yield* QueryEngineService,
			})
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.ai.service": params.service,
				"maple.ai.environment": params.environment ?? "all",
				"maple.ai.trace_scoped": params.trace_id !== undefined,
			})

			const scope = yield* Schema.decodeEffect(ProfileSampleTypesRequest)({
				startTime: st,
				endTime: et,
				serviceName: params.service,
				...(params.environment === undefined ? undefined : { deploymentEnv: params.environment }),
				...(params.trace_id === undefined ? undefined : { traceId: params.trace_id }),
			}).pipe(
				Effect.mapError(
					(error) =>
						new McpInvalidInputError({ message: `Invalid profile scope: ${error.message}` }),
				),
			)

			const sampleTypes = yield* reads
				.sampleTypes(tenant, scope)
				.pipe(Effect.catchTags(readHandlers("profile_sample_types")))
			const base = {
				timeRange: { start: st, end: et },
				serviceName: params.service,
				...(params.environment === undefined ? undefined : { environment: params.environment }),
				...(params.trace_id === undefined ? undefined : { traceId: params.trace_id }),
				sampleTypes: Arr.map(sampleTypes, (row) => ({
					sampleType: row.sampleType,
					sampleUnit: row.sampleUnit,
					value: row.value,
					profiles: row.profiles,
					durationNano: row.durationNano,
				})),
			}
			const wanted = params.sample_type ?? DEFAULT_SAMPLE_TYPE
			const chosen =
				sampleTypes.find((row) => row.sampleType === wanted) ??
				(params.sample_type === undefined ? sampleTypes[0] : undefined)
			if (chosen === undefined) {
				if (sampleTypes.length > 0) {
					return yield* new McpInvalidInputError({
						message: `No \`${wanted}\` samples in this scope. Sample types present: ${Arr.join(
							Arr.map(sampleTypes, (row) => row.sampleType),
							", ",
						)}.`,
						parameter: "sample_type",
					})
				}
				return { ...base, totalValue: 0, totalStacks: 0, truncated: false, functions: [] }
			}

			// Decoded, not constructed: a stored sample type can be longer than a request allows.
			const request = yield* Schema.decodeEffect(ProfileStacksRequest)({
				...scope,
				sampleType: chosen.sampleType,
				sampleUnit: chosen.sampleUnit,
			}).pipe(
				Effect.mapError(
					() =>
						new McpInvalidInputError({
							message: `The \`${chosen.sampleType}\` sample type cannot be read; pick another with sample_type.`,
							parameter: "sample_type",
						}),
				),
			)
			const read = yield* reads
				.stacks(tenant, request)
				.pipe(Effect.catchTags(readHandlers("profile_stacks")))
			const functions = topFunctions(read, params.limit)
			yield* Effect.annotateCurrentSpan({
				"maple.ai.sample_type": chosen.sampleType,
				"result.rowCount": functions.length,
				"maple.profile.truncated": read.truncated,
			})
			return {
				...base,
				sampleType: chosen.sampleType,
				sampleUnit: chosen.sampleUnit,
				totalValue: read.totalValue,
				totalStacks: read.totalStacks,
				truncated: read.truncated,
				functions,
			}
		}),
		render: (output) => {
			const unit = output.sampleUnit ?? ""
			const value = (n: number) => formatProfileValue(unit, n)
			const others = Arr.dedupe(
				Arr.filterMap(output.sampleTypes, (row) =>
					row.sampleType === output.sampleType ? Result.failVoid : Result.succeed(row.sampleType),
				),
			)
			const typeRows = Arr.map(output.sampleTypes, (row) => {
				const cores = averageCores(row, output.traceId !== undefined)
				return [
					row.sampleType,
					formatProfileValue(row.sampleUnit, row.value),
					cores === undefined ? "—" : cores.toFixed(2),
					formatNumber(row.profiles),
				]
			})
			return {
				title: `Profile Hotspots: ${output.serviceName}`,
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Environment", output.environment],
					["Trace", output.traceId],
					["Sample type", output.sampleType],
				],
				...(output.sampleTypes.length === 0
					? {
							empty: {
								message: `No profiles from ${output.serviceName}${output.traceId === undefined ? "" : " linked to this trace"} in the given time range.`,
								hints: [
									"Profiles exist only where the service runs a profiler (the Maple SDK's `profiling: true`).",
									"Ingest refuses profile uploads from an org whose plan lacks profiles, so a profiled service can still show none.",
									"Widen start_time/end_time if the service exported profiles earlier.",
								],
							},
						}
					: undefined),
				blocks:
					output.sampleTypes.length === 0
						? []
						: [
								doc.heading("Sample types"),
								doc.table(["Type", "Total", "Avg cores", "Profiles"], typeRows),
								doc.heading(`Top functions by self ${output.sampleType ?? ""}`),
								output.functions.length === 0
									? doc.text("No stacks in this sample type.")
									: doc.table(
											["Function", "Self", "Self %", "Total", "Total %", "Location"],
											Arr.map(output.functions, (fn) => [
												tableCell(fn.name, 80),
												value(fn.self),
												percentOf(fn.self, output.totalValue),
												value(fn.total),
												percentOf(fn.total, output.totalValue),
												fn.file === "" ? "—" : tableCell(`${fn.file}:${fn.line}`, 80),
											]),
										),
							],
				...(output.truncated
					? {
							notices: [
								`Read the heaviest stacks of ${formatNumber(output.totalStacks)}; percentages are of the whole window, so the listed functions may sum to less than 100%.`,
							],
						}
					: undefined),
				next: [
					...(output.traceId === undefined
						? []
						: [
								doc.next(
									"inspect_trace",
									{ trace_id: output.traceId },
									"see the spans these samples ran under",
								),
							]),
					...Arr.map(others.slice(0, 2), (sampleType) =>
						doc.next(
							"profile_hotspots",
							{
								service: output.serviceName,
								sample_type: sampleType,
								environment: output.environment,
								trace_id: output.traceId,
								start_time: output.timeRange.start,
								end_time: output.timeRange.end,
							},
							`read the ${sampleType} profile`,
						),
					),
					doc.next(
						"get_service_top_operations",
						{
							service: output.serviceName,
							environment: output.environment,
							start_time: output.timeRange.start,
							end_time: output.timeRange.end,
						},
						"find the operations that run this code",
					),
				],
			}
		},
	})
}
