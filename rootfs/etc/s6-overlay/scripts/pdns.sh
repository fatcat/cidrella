#!/bin/sh
# Run one PowerDNS daemon (pdns.sh auth or pdns.sh recursor) once CIDRella
# wants it. PowerDNS runs only while it is the DNS server: until then this
# waits for the enable file CIDRella writes (backends/pdns/paths.js
# enableFlagPath) and removes on stop. The paths must agree with
# backends/pdns/paths.js; CIDRella renders both config dirs.
DAEMON="$1"
FLAG="/data/runtime/pdns-${DAEMON}.enabled"
while [ ! -f "$FLAG" ]; do
  sleep 1
done

install -d -m 0750 -o cidrella -g cidrella /data/pdns/run

# Output goes to pdns.log, the DNS log CIDRella shows on this stack; CIDRella
# writes its query lines into the same file. Created as cidrella, so both can.
LOG=/data/pdns/pdns.log
if [ ! -e "$LOG" ]; then
  : >"$LOG"
  chown cidrella:cidrella "$LOG"
  chmod 0640 "$LOG"
fi

# By name, not path: busybox `pkill -x`, which CIDRella stops it with, matches
# the whole of argv[0].
if [ "$DAEMON" = "auth" ]; then
  exec s6-setuidgid cidrella pdns_server --config-dir=/data/pdns/auth \
    --guardian=no --daemon=no --disable-syslog --write-pid=no >>"$LOG" 2>&1
fi
exec s6-setuidgid cidrella pdns_recursor --config-dir=/data/pdns/recursor \
  --daemon=no --disable-syslog --write-pid=no >>"$LOG" 2>&1
