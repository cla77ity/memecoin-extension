# SolSniper Telegram bot (24/7 live scanner). No npm dependencies.
FROM node:22-alpine
WORKDIR /app
COPY engine.js analyzer.js scanner.js bot.js ./
USER node
CMD ["node", "bot.js"]
