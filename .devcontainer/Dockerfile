FROM oven/bun:1.3.12-alpine

WORKDIR /workspace

COPY package.json ./
COPY src ./src

EXPOSE 3000

CMD ["bun", "run", "start"]
