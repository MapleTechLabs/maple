import { WeeklyDigest } from "../weekly-digest"
import { baseDigestProps } from "./_sample"

/** react-email preview entry — "critical" week (a service on fire). */
export default function WeeklyDigestCriticalPreview() {
	return WeeklyDigest({
		...baseDigestProps,
		summary: {
			...baseDigestProps.summary,
			requests: { value: 760_000, delta: -18.2 },
			errors: { value: 61_800, delta: 142.0 },
			p95Latency: { valueMs: 980, delta: 96.3 },
			dataVolume: { valueBytes: 12_100_000_000, delta: -22.0 },
		},
		series: baseDigestProps.series.map((d, i) => ({
			...d,
			errors: Math.round(d.requests * (0.03 + i * 0.012)),
		})),
		services: [
			{ name: "payments", requests: 88_000, errorRate: 14.6, p95Ms: 2100, requestsDelta: -41.0 },
			{ name: "checkout", requests: 64_000, errorRate: 8.2, p95Ms: 1450, requestsDelta: -33.5 },
			{ name: "api-gateway", requests: 380_000, errorRate: 4.1, p95Ms: 320, requestsDelta: -12.0 },
			{ name: "auth-service", requests: 210_000, errorRate: 2.0, p95Ms: 240, requestsDelta: -5.1 },
		],
		topErrors: [
			{
				message: "PaymentGatewayTimeout: upstream did not respond within 5000ms",
				count: 18_420,
				affectedServices: 4,
				isNew: true,
			},
			{
				message: "DeadlockDetected: serialization failure on orders table",
				count: 9310,
				affectedServices: 2,
				isNew: true,
			},
			{
				message: "NullPointerException in UserService.getProfile",
				count: 1204,
				affectedServices: 3,
				isNew: false,
			},
		],
	})
}
