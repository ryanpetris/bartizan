#!/bin/sh
set -eu
printf 'node:bartizan-test-password\n' | chpasswd
ssh-keygen -q -t ed25519 -N '' -f /tmp/hostkey
cat >/tmp/sshd_config <<'CONFIG'
Port 2222
ListenAddress 0.0.0.0
HostKey /tmp/hostkey
PidFile /tmp/sshd.pid
AuthorizedKeysFile /fixtures/client.pub
StrictModes no
PasswordAuthentication yes
KbdInteractiveAuthentication yes
UsePAM yes
PermitRootLogin no
AllowTcpForwarding yes
LogLevel ERROR
CONFIG
node /work/scripts/rigs/fixtures/remote.mjs &
exec /usr/sbin/sshd -D -e -f /tmp/sshd_config
