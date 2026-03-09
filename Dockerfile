FROM node:20-alpine AS client-build

ARG DEV_TRACKING=0

WORKDIR /build/client
COPY client/package.json client/package-lock.json* ./
RUN npm install
COPY client/ ./
RUN VITE_TRACKING=$DEV_TRACKING npx vite build

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
    bind-tools \
    sudo \
    tzdata

# Create non-root user for Node.js
RUN addgroup -g 65532 cidrella && \
    adduser -D -u 65532 -G cidrella -H -s /sbin/nologin cidrella

# Allow cidrella user to send signals to dnsmasq and run network scans
RUN echo 'cidrella ALL=(root) NOPASSWD: /usr/bin/kill -HUP [0-9]*' > /etc/sudoers.d/cidrella-dnsmasq && \
    echo 'cidrella ALL=(root) NOPASSWD: /usr/bin/nmap *' >> /etc/sudoers.d/cidrella-dnsmasq && \
    echo 'cidrella ALL=(root) NOPASSWD: /usr/sbin/arping *' >> /etc/sudoers.d/cidrella-dnsmasq && \
    chmod 440 /etc/sudoers.d/cidrella-dnsmasq

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
ENV PATH="/command:${PATH}"

# Expose ports
EXPOSE 8443 8080 53/udp 53/tcp 67/udp

ENTRYPOINT ["/init"]
