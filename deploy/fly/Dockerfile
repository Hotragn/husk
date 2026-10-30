# Husk's control plane serving remote access, in a Fly app of your own
# (apps/docs/content/guides/remote-access.mdx). Its computers are Fly machines
# in a second app; nothing runs in this image but Husk.
FROM node:22-slim

# The Husk release to run: one with remote access. Pin it with
# `fly deploy --build-arg HUSK_VERSION=<version>`.
ARG HUSK_VERSION=latest
RUN npm install -g "@husk-ai/cli@${HUSK_VERSION}" && npm cache clean --force

# The API and console stay on loopback inside the machine. Remote access's own
# port listens for Fly's proxy, which reaches the machine on 0.0.0.0, never on
# loopback. Husk's state is ~/.husk, the volume fly.toml mounts.
EXPOSE 8080
CMD ["sh", "-c", "exec husk serve --remote --public-url \"$HUSK_PUBLIC_URL\" --provider fly --remote-host 0.0.0.0 --remote-port 8080"]
