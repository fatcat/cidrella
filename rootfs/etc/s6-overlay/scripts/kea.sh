#!/bin/sh
# Run one Kea daemon (kea.sh 4 or kea.sh 6) once CIDRella wants it. Kea runs
# only while it is the DHCP server: until then this waits for the enable file
# CIDRella writes (backends/kea/paths.js enableFlagPath) and removes on stop.
# The paths and KEA_* variables must agree with backends/kea/paths.js.
FAMILY="$1"
FLAG="/data/runtime/kea-dhcp${FAMILY}.enabled"
while [ ! -f "$FLAG" ]; do
  sleep 1
done

# Kea wants its control-socket directory 0750 or stricter.
install -d -m 0750 -o cidrella -g cidrella /data/kea/run
install -d -m 0750 -o cidrella -g cidrella /data/kea/log

export KEA_DHCP_DATA_DIR=/data/kea
export KEA_LOG_FILE_DIR=/data/kea/log
export KEA_LEGAL_LOG_DIR=/data/kea/log
export KEA_CONTROL_SOCKET_DIR=/data/kea/run
export KEA_PIDFILE_DIR=/data/kea/run
export KEA_LOCKFILE_DIR=/data/kea/run
# By name, not path: busybox `pkill -x`, which CIDRella stops it with, matches
# the whole of argv[0].
exec s6-setuidgid cidrella "kea-dhcp${FAMILY}" -c "/data/kea/kea-dhcp${FAMILY}.conf"
