#!/bin/sh
# husk entrypoint
#
# A husk container is an exec host: the runtime keeps it alive and runs work
# through `docker exec`. The entrypoint's only jobs are to run the one-time
# setup script if the runtime mounted one, then park forever without burning CPU.
set -eu

log() { printf 'husk: %s\n' "$1" >&2; }

# The runtime writes /work/.husk/setup.sh when the spec has `packages` or `setup`.
# It runs once; the marker survives container restarts because /work persists.
SETUP="/work/.husk/setup.sh"
MARKER="/work/.husk/.setup-done"

if [ -f "$SETUP" ] && [ ! -f "$MARKER" ]; then
    log "running setup"
    if sh "$SETUP" >/work/.husk/setup.log 2>&1; then
        : >"$MARKER"
        log "setup complete"
    else
        # A failed setup must not take the machine down: the agent may well be able
        # to work without the extra packages, and it can read the log to find out why.
        log "setup FAILED (exit $?) -- see /work/.husk/setup.log"
    fi
fi

case "${1:-idle}" in
    idle)
        log "ready"
        # `sleep infinity` is a single blocked syscall: no wakeups, no drift, and it
        # forwards signals correctly under tini so `docker stop` is instant.
        exec sleep infinity
        ;;
    *)
        exec "$@"
        ;;
esac
