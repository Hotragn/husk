#!/usr/bin/env bash
# Build (and optionally push) the husk images.
#
#   ./build.sh                 build all flavors locally
#   ./build.sh base python     build a subset
#   HUSK_REGISTRY=ghcr.io/you PUSH=1 ./build.sh   multi-arch, pushed to a registry
set -euo pipefail

cd "$(dirname "$0")"

# No default registry. husk ships no images of its own -- every flavor resolves
# to a public upstream image -- so these Dockerfiles exist for the one case that
# wants something else: an air-gapped site, or somewhere that mirrors every
# image it runs. Building locally needs no namespace; pushing needs yours.
REGISTRY="${HUSK_REGISTRY:-}"
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

if [[ "${PUSH:-0}" == "1" && -z "$REGISTRY" ]]; then
    echo "PUSH=1 needs HUSK_REGISTRY set -- there is nowhere to push to" >&2
    exit 1
fi

# `ghcr.io/you/husk-base:0.1.0` when pushing, plain `husk-base:0.1.0` locally.
prefix="${REGISTRY:+${REGISTRY}/}"

for flavor in "${TARGETS[@]}"; do
    tag="${prefix}husk-${flavor}:${VERSION}"
    latest="${prefix}husk-${flavor}:latest"
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
        # Later flavors default to `FROM husk-base:$VERSION`, which resolves
        # against the local daemon -- exactly the tag written above.
    fi
done

echo
echo "built: ${TARGETS[*]}"
docker image ls --filter "reference=${REGISTRY}/husk-*" \
    --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}' 2>/dev/null || true
