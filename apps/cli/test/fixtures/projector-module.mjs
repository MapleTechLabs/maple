// Deliberately dependency-free: the compiled binary loads this from outside its bundle.
export default {
	apiVersion: 1,
	register(register) {
		register({
			id: "example.record.observed",
			version: 1,
			sourceKinds: ["otel.log"],
			outputType: "dev.maple.example.record.observed.v1",
			dataSchema: "urn:example:record-observed:v1",
			decodeConfig: () => ({ label: "external projector" }),
			decodeOutput: (value) => value,
			project: (signal, config) => ({
				subject: "records/42",
				data: { label: config.label, occurrenceId: signal.occurrenceId },
			}),
		})
	},
}
