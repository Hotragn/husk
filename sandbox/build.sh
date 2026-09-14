#!/usr/bin/env bash
# Build (and optionally push) the husk images.
#
#   ./build.sh                 build all flavors locally
#   ./build.sh base python     build a subset
#   PUSH=1 ./build.sh          build multi-arch and push to the registry
set -euo pipefail

cd "$(dirname "$0")"

REGISTRY="${HUSK_REGISTRY:-ghcr.io/husk-sh}"
VERSION="${HUSK_VERSION:-0.1.0}"
PLATFORMS="${HUSK_PLATFORMS:-linux/amd64,linux/arm64}"
PUSH="${PUSH:-0}"

# base must be first: every other flavor is FROM it.
ALL=(base python node full)
TARGETS=("${@:-${ALL[@]}}")

if ! docker version >/dev/null 2>&1; then
    echo "docker daemon is not reachable -- start Docker and retry" >&2
    exit 1
fi

for flavor in "${TARGETS[@]}"; do
    tag="${REGISTRY}/husk-${flavor}:${VERSION}"
    latest="${REGISTRY}/husk-${flavor}:latest"
    echo "==> ${tag}"

    if [[ "$PUSH" == "1" ]]; then
        docker buildx build \
            --platform "$PLATFORMS" \
            --build-arg "HUSK_VERSION=${VERSION}" \
            --tag "$tag" --tag "$latest" \
            --file "Dockerfile.${flavor}" \
            --push .
    else
        # Local builds stay single-arch: buildx multi-arch cannot load into the
        # daemon, and a developer wants the image usable immediately.
        docker build \
            --build-arg "HUSK_VERSION=${VERSION}" \
            --tag "$tag" --tag "$latest" \
            --file "Dockerfile.${flavor}" .
        # Later flavors resolve `FROM ghcr.io/husk-sh/husk-base:$VERSION` against the
        # local daemon, so the tag above is exactly what they need.
    fi
done

echo
echo "built: ${TARGETS[*]}"
docker image ls --filter "reference=${REGISTRY}/husk-*" \
    --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}' 2>/dev/null || true
