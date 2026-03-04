FROM node:20-alpine AS client-build

WORKDIR /build/client
COPY client/package.json client/package-lock.json* ./
RUN npm install
COPY client/ ./
RUN npx vite build

FROM node:20-alpine

# s6-overlay version
ARG S6_OVERLAY_VERSION=3.2.0.2

# Install s6-overlay
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz /tmp
RUN tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz && \
    tar -C / -Jxpf /tmp/s6-overlay-x86_64.tar.xz && \
    rm /tmp/s6-overlay-*.tar.xz

# Install system dependencies
RUN apk add --no-cache \
    dnsmasq \
    openssl \
    arping \
    nmap \
    bind-tools

# Set up app directory
WORKDIR /app

# Install server dependencies
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --production

# Copy application code
COPY server/ ./server/
COPY dnsmasq/ ./dnsmasq/

# Copy built client
COPY --from=client-build /build/client/dist ./client/dist/

# Copy s6-overlay service definitions
COPY rootfs/ /

# Make scripts executable
RUN chmod +x /etc/s6-overlay/scripts/*.sh && \
    chmod +x /etc/s6-overlay/s6-rc.d/*/run 2>/dev/null || true

# Environment
ENV DATA_DIR=/data
ENV HTTPS_PORT=8443
ENV HTTP_PORT=8080
ENV S6_KEEP_ENV=1

# Expose ports
EXPOSE 8443 8080 53/udp 53/tcp 67/udp

ENTRYPOINT ["/init"]
