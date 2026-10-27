# The hub in one image. Data lives in /data (a volume); `axos` inside the container is the admin command:
#   docker compose exec axos axos init <your name>
FROM oven/bun:1-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src
RUN printf '#!/bin/sh\nexec bun /app/src/cli.ts "$@"\n' > /usr/local/bin/axos && chmod 755 /usr/local/bin/axos \
 && mkdir -p /data && chown bun:bun /data
ENV AXOS_DB=/data/axos.db AXOS_HOST=0.0.0.0 AXOS_PORT=18900
USER bun
VOLUME /data
EXPOSE 18900
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://127.0.0.1:18900/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["bun", "src/server.ts"]
