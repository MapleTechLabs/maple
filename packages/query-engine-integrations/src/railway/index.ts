// Railway integration queries: the /infra/railway fleet table and per-service charts.

export {
	RAILWAY_CPU_LIMIT,
	RAILWAY_CPU_USAGE,
	RAILWAY_DISK_USAGE,
	RAILWAY_MEMORY_LIMIT,
	RAILWAY_MEMORY_USAGE,
	RAILWAY_NETWORK_IO,
	railwayServicesSQL,
	railwayServiceTimeseriesSQL,
	type RailwayServicesOutput,
	type RailwayServiceTimeseriesOutput,
} from "./railway-infra"
