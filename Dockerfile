FROM node:22-alpine AS web

WORKDIR /src/web

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/build.mjs web/index.html web/styles.css web/tsconfig.json ./
COPY web/src/ ./src/
COPY shared/ /src/shared/
RUN npm run build

FROM golang:1.27.4-alpine AS server

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY *.go schema.sql ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/whiteboard .

FROM alpine:3.23

RUN apk add --no-cache ca-certificates

COPY --from=server /out/whiteboard /usr/local/bin/whiteboard
COPY --from=web /src/web/dist /var/www/whiteboard

USER 65532:65532
