FROM node:24-alpine AS client-build

ARG DEV_TRACKING=0

WORKDIR /build/client
COPY client/package.json client/package-lock.json* ./
RUN npm install
COPY client/ ./
RUN VITE_TRACKING=$DEV_TRACKING npx vite build

FROM node:24-alpine

# s6-overlay version
ARG S6_OVERLAY_VERSION=3.2.3.2
ARG TARGETARCH

# Install s6-overlay (noarch + arch-specific)
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp/s6-overlay-noarch.tar.xz
RUN S6_ARCH=$(case "$TARGETARCH" in arm64) echo "aarch64";; arm) echo "armhf";; *) echo "x86_64";; esac) && \
    wget -q -O /tmp/s6-overlay-arch.tar.xz \
      "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" && \
    tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz && \
    tar -C / -Jxpf /tmp/s6-overlay-arch.tar.xz && \
    rm /tmp/s6-overlay-noarch.tar.xz /tmp/s6-overlay-arch.tar.xz

# Install system dependencies
RUN apk add --no-cache \
    dnsmasq \
    openssl \
    arping \
    iputils \
    bind-tools \
    sudo \
    tzdata \
    libcap

# Create non-root user for Node.js
RUN addgroup -g 65532 cidrella && \
    adduser -D -u 65532 -G cidrella -H -s /sbin/nologin cidrella

# Allow cidrella user to send signals to dnsmasq and run network scans.
# nmap was in this allowlist historically but the app never called it;
# removed in v0.4.10 to drop both the unused binary and its wildcard
# sudoers rule. arping is kept because the scanner actually uses it.
RUN echo 'cidrella ALL=(root) NOPASSWD: /usr/bin/kill -HUP [0-9]*' > /etc/sudoers.d/cidrella-dnsmasq && \
    echo 'cidrella ALL=(root) NOPASSWD: /usr/bin/pkill -TERM -x dnsmasq' >> /etc/sudoers.d/cidrella-dnsmasq && \
    echo 'cidrella ALL=(root) NOPASSWD: /usr/sbin/arping *' >> /etc/sudoers.d/cidrella-dnsmasq && \
    chmod 440 /etc/sudoers.d/cidrella-dnsmasq

# Set up app directory
WORKDIR /app

# Install server dependencies and Python ML dependencies for anomaly detection sidecar
COPY server/package.json server/package-lock.json* ./server/
RUN apk add --no-cache python3 py3-pip py3-scikit-learn py3-numpy py3-joblib && \
    apk add --no-cache --virtual .build-deps py3-setuptools make g++ && \
    cd server && npm install --production && cd .. && \
    apk del .build-deps && \
    setcap cap_net_raw,cap_net_bind_service+ep $(readlink -f $(which node))

# Copy application code
COPY package.json ./
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
