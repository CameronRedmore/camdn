FROM node:alpine

WORKDIR /app

RUN npm i -g pnpm

COPY . .

RUN pnpm install

EXPOSE 3000

CMD ["npm", "start"]