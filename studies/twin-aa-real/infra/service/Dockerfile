# studies/twin-aa-real/infra/service/Dockerfile — the synthetic old version. Build once, push once,
# record the digest (R2): every service in a lane must run the same digest.
FROM node:22-alpine
WORKDIR /app
COPY server.mjs /app/server.mjs
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "/app/server.mjs"]
