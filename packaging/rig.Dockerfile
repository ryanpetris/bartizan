FROM node:24-bookworm@sha256:6dac556d980b7f0e5498d08f08cee0ca67798b4ad6c23964a9214920e67758d0
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server tmux screen python3 chromium xvfb xauth openbox xdotool x11-utils vim libgtk-3-0 libnss3 libasound2 libxss1 libgbm1 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /run/sshd
WORKDIR /work
RUN chown node:node /work
USER node
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node scripts/postinstall.mjs scripts/postinstall.mjs
RUN npm ci
COPY --chown=node:node . .
RUN npm run build
USER root
