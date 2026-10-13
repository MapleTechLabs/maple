# The upstream ElectricSQL sync service, unmodified.
#
# A Dockerfile rather than an image reference because alchemy's ECS service
# builds a context and pushes to ECR — so the task pulls from there over the
# VPC's S3 gateway endpoint, not from Docker Hub on every placement.
#
# PINNED, never `:latest`. `docker-compose.yml` tracks `:latest` locally on
# purpose, but here an upgrade is a deliberate read of the release notes: the
# storage format has changed across minors, and rolling back after the new
# version has rewritten the shape cache re-snapshots every connected client.
#
# Built from upstream source into our own registry by publish-electric-image.yml:
# upstream's Docker Hub repo was deleted (electric-sql/electric#4822). To upgrade,
# run that workflow with the new version and pin the digest from its summary.
FROM ghcr.io/mapletechlabs/maple/electric:1.7.12@sha256:d8a377eee0edeac0d4dbbd77c22b92c1ef601184722ea2b7da5b3381e3bb8e2c
