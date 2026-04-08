FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 8080
CMD ["node", "server/index.js"]
