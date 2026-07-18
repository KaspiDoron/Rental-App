# Minimal image for the wd-queue-drain cron. node:22-alpine has global fetch and
# needs no dependencies. The CMD is an exec array (no shell), so there is nothing
# for Render's blueprint parser to mangle - the inline dockerCommand string kept
# failing with exit 127.
FROM node:22-alpine
WORKDIR /app
COPY ping.mjs /app/ping.mjs
CMD ["node", "/app/ping.mjs"]
