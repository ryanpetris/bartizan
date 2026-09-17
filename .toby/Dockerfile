FROM archlinux:base-devel

RUN pacman -Syu --noconfirm \
 alsa-lib \
 bash \
 ca-certificates \
 curl \
 dbus \
 git \
 gtk3 \
 gzip \
 libxcomposite \
 libxdamage \
 libxkbcommon \
 libxrandr \
 libxss \
 mesa \
 nodejs \
 npm \
 nss \
 openbox \
 openssh \
 openssl \
 python \
 tar \
 unzip \
 vim \
 xdotool \
 xorg-server-xvfb \
 xorg-xauth \
 xorg-xprop \
 xorg-xwininfo \
 zstd \
 && pacman -Scc --noconfirm

RUN groupadd --gid 1000 toby \
 && useradd --uid 1000 --gid 1000 --home-dir /toby/home --no-create-home --shell /usr/bin/bash toby \
 && groupmod --non-unique --gid 1000 tty \
 && mkdir -p /run/sshd
