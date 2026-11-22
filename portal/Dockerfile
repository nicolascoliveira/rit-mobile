# Multi-stage build for the Rit B2B SaaS Management Portal (Super Admin + Gyms)
FROM --platform=$BUILDPLATFORM node:22.23.4-alpine AS build

WORKDIR /app/portal
COPY portal/package.json portal/package-lock.json* ./
RUN npm ci --ignore-scripts

COPY portal/ ./
COPY api/student-import.js /app/api/student-import.js
ARG VITE_STUDENT_APP_URL=""
ENV VITE_STUDENT_APP_URL=$VITE_STUDENT_APP_URL
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.30.6-alpine
USER root
RUN apk upgrade --no-cache \
 && sed -i '/^[[:space:]]*user[[:space:]]/d' /etc/nginx/nginx.conf \
 && sed -i 's,\(/var\)\{0\,1\}/run/nginx.pid,/tmp/nginx.pid,' /etc/nginx/nginx.conf \
 && if ! grep -q 'client_body_temp_path' /etc/nginx/nginx.conf; then \
      sed -i "/^http {/a \    proxy_temp_path /tmp/proxy_temp;\n    client_body_temp_path /tmp/client_temp;\n    fastcgi_temp_path /tmp/fastcgi_temp;\n    uwsgi_temp_path /tmp/uwsgi_temp;\n    scgi_temp_path /tmp/scgi_temp;\n" /etc/nginx/nginx.conf; \
    fi \
 && chown -R nginx:root /var/cache/nginx /etc/nginx \
 && chmod -R g+w /var/cache/nginx /etc/nginx
USER 101

COPY portal/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/portal/dist /usr/share/nginx/html
COPY catalogue/media/ /usr/share/nginx/html/exercise-media/

ENV NGINX_PORT=80
ENV BACKEND=api
ENV PORT=3000
ENV RESOLVER=127.0.0.11
ENV CF_CONNECTING_IP=""

HEALTHCHECK --interval=30s \
            --timeout=5s \
            --start-period=20s \
            --retries=3 \
            CMD wget --spider -q "http://127.0.0.1:${NGINX_PORT}/" || exit 1
