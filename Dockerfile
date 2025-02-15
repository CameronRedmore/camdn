FROM node:alpine

WORKDIR /app

RUN apk add ffmpeg

RUN npm i -g pnpm

COPY . .

RUN pnpm install

EXPOSE 3000

CMD ["npm", "start"]