FROM node:22-alpine

WORKDIR /runner
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node src ./src

ENV NODE_ENV=production
ENV CONNECTOR_RUNNER_HOST=0.0.0.0
ENV CONNECTOR_RUNNER_PORT=8788

USER node
CMD ["node", "src/index.mjs"]
