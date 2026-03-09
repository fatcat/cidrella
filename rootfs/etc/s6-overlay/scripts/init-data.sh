#!/bin/sh
# Initialize data directories and set ownership for cidrella user

PUID=${PUID:-65532}
PGID=${PGID:-65532}

mkdir -p /data/certs
mkdir -p /data/backups
mkdir -p /data/dnsmasq/hosts.d
mkdir -p /data/dnsmasq/dhcp-hosts.d
mkdir -p /data/dnsmasq/conf.d
mkdir -p /data/blocklists

# Copy default dnsmasq config if not present
if [ ! -f /data/dnsmasq/dnsmasq.conf ]; then
  cp /app/dnsmasq/dnsmasq.conf.default /data/dnsmasq/dnsmasq.conf
  echo "Copied default dnsmasq configuration"
fi

# Fix listen-address=0.0.0.0 — dnsmasq with bind-dynamic ignores 0.0.0.0
# Replace with 127.0.0.1 + all real interface IPs
if grep -q '^listen-address=0\.0\.0\.0' /data/dnsmasq/dnsmasq.conf; then
  # Build replacement: 127.0.0.1 + each non-loopback IPv4 address
  LISTEN_LINES="listen-address=127.0.0.1"
  for addr in $(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1); do
    LISTEN_LINES="$LISTEN_LINES\nlisten-address=$addr"
  done
  sed -i "s|^listen-address=0\.0\.0\.0|${LISTEN_LINES}|" /data/dnsmasq/dnsmasq.conf
  echo "Fixed dnsmasq listen-address: replaced 0.0.0.0 with explicit IPs"
fi

# Ensure log-facility and pid-file are present
if ! grep -q '^log-facility=' /data/dnsmasq/dnsmasq.conf; then
  echo "log-facility=/data/dnsmasq/dnsmasq.log" >> /data/dnsmasq/dnsmasq.conf
  echo "Added log-facility to dnsmasq config"
fi
if ! grep -q '^pid-file=' /data/dnsmasq/dnsmasq.conf; then
  echo "pid-file=/data/dnsmasq/dnsmasq.pid" >> /data/dnsmasq/dnsmasq.conf
  echo "Added pid-file to dnsmasq config"
fi

# Remove existing cidrella user/group (from Dockerfile defaults)
deluser cidrella 2>/dev/null
delgroup cidrella 2>/dev/null

# Remove any other user/group that conflicts with requested PUID/PGID
CONFLICT_USER=$(getent passwd "$PUID" 2>/dev/null | cut -d: -f1)
if [ -n "$CONFLICT_USER" ]; then
  deluser "$CONFLICT_USER" 2>/dev/null
  echo "Removed conflicting user $CONFLICT_USER (had UID $PUID)"
fi

CONFLICT_GROUP=$(getent group "$PGID" 2>/dev/null | cut -d: -f1)
if [ -n "$CONFLICT_GROUP" ]; then
  delgroup "$CONFLICT_GROUP" 2>/dev/null
  echo "Removed conflicting group $CONFLICT_GROUP (had GID $PGID)"
fi

# Create cidrella group and user with requested PUID/PGID
addgroup -g "$PGID" cidrella
adduser -D -u "$PUID" -G cidrella -H -s /sbin/nologin cidrella

# Create dnsmasq log file so the Node process can read it
touch /data/dnsmasq/dnsmasq.log
chmod 644 /data/dnsmasq/dnsmasq.log

# Set ownership on data directory
chown -R "$PUID:$PGID" /data
echo "Data directory owned by cidrella (PUID=$PUID PGID=$PGID)"
