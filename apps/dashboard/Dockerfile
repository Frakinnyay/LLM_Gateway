# syntax=docker/dockerfile:1
# Dashboard image: build static assets, serve with unprivileged nginx. BUILD CONTEXT IS THE REPO ROOT:
#   docker build -f apps/dashboard/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/dashboard/package.json apps/dashboard/package.json
RUN if [ -f package-lock.json ]; then npm ci -w apps/dashboard; else npm install -w apps/dashboard; fi
COPY apps/dashboard apps/dashboard
RUN npm run build -w apps/dashboard

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
