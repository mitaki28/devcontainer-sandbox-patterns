FROM oven/bun:1@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

EXPOSE 8000
ENTRYPOINT ["bun", "run", "src/index.ts"]
