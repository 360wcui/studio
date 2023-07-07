# Build stage
FROM node:16 as build
WORKDIR /src
COPY . ./

RUN corepack enable
RUN yarn install --immutable

RUN yarn run web:build:prod

# Release stage
FROM caddy:2.5.2-alpine
WORKDIR /src
COPY --from=build /src/web/.webpack ./

EXPOSE 8080
CMD \
    index_html=$(cat index.html) \
    && replace_pattern='/*FOXGLOVE_STUDIO_DEFAULT_LAYOUT_PLACEHOLDER*/' \
    && echo ${index_html/"$replace_pattern"/$FOXGLOVE_STUDIO_DEFAULT_LAYOUT} > index.html \
    && caddy file-server --listen :8080
