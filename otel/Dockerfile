FROM otel/opentelemetry-collector-contrib:latest

COPY ./otel/collector-config.yaml /etc/otelcol/config.yaml

EXPOSE 4317 4318 13133

CMD ["--config", "/etc/otelcol/config.yaml"]
