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
