#!/bin/sh
# Initialize data directories, create ipam user, and set ownership

PUID=${PUID:-0}
PGID=${PGID:-0}

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

# Create ipam group and user with the requested PUID/PGID
if [ "$PUID" -ne 0 ]; then
  if ! getent group ipam >/dev/null 2>&1; then
    addgroup -g "$PGID" ipam
  fi
  if ! getent passwd ipam >/dev/null 2>&1; then
    adduser -D -u "$PUID" -G ipam -H -s /sbin/nologin ipam
  fi
  chown -R "$PUID:$PGID" /data
  echo "Data directory owned by PUID=$PUID PGID=$PGID"
fi
