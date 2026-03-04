#!/bin/sh
# Initialize data directories and default configs

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
