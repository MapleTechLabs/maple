# Self-hosted Maple Local: OTLP ingest, the query API and the dashboard on one
# port, with an ingest key and an access token required (see entrypoint.sh).
#
# The build context is a directory holding prebuilt bundles and this folder:
#   linux-amd64/{maple,libchdb.so}  linux-arm64/{maple,libchdb.so}  entrypoint.sh
# The release workflow assembles it from the native Linux builds, and
# `apps/cli/docker/build-image.sh` does the same locally. The final stage only
# copies files, so a multi-arch build needs no emulation.

FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS rootfs
ARG TARGETARCH
COPY linux-${TARGETARCH}/maple linux-${TARGETARCH}/libchdb.so /rootfs/opt/maple/
COPY entrypoint.sh /rootfs/opt/maple/entrypoint.sh
RUN chmod 0755 /rootfs/opt/maple/maple /rootfs/opt/maple/entrypoint.sh \
	&& chmod 0644 /rootfs/opt/maple/libchdb.so \
	&& mkdir -p /rootfs/data \
	&& chown 10001:10001 /rootfs/data

FROM debian:bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/MapleTechLabs/maple" \
	org.opencontainers.image.description="Self-hosted Maple Local: OpenTelemetry ingest, queries and dashboard"
COPY --from=rootfs /rootfs/ /
# HOME on the volume keeps every CLI default (store, PID file, config) there,
# so `docker exec <container> maple services` needs no flags.
ENV HOME=/data \
	PATH=/opt/maple:$PATH \
	MAPLE_NO_UPDATE_CHECK=1
VOLUME /data
EXPOSE 4318
ENTRYPOINT ["/opt/maple/entrypoint.sh"]
CMD ["start"]
