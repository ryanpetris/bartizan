FROM node:24-bookworm@sha256:6dac556d980b7f0e5498d08f08cee0ca67798b4ad6c23964a9214920e67758d0
RUN apt-get update && apt-get install -y --no-install-recommends libarchive-tools && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG BARTIZAN_VERSION
ARG SOURCE_DATE_EPOCH
ENV BARTIZAN_VERSION=$BARTIZAN_VERSION SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH
RUN python3 tools/version.py && npm run build && mkdir -p build && printf '%s\n' "$BARTIZAN_VERSION" > build/VERSION \
    && npx --no-install electron-builder --linux --x64 --dir --publish never --config.extraMetadata.version="$BARTIZAN_VERSION" \
    && find release/linux-unpacked -exec touch --no-dereference --date="@$SOURCE_DATE_EPOCH" {} + \
    && npx --no-install electron-builder --linux --x64 --prepackaged release/linux-unpacked --publish never --config.extraMetadata.version="$BARTIZAN_VERSION" \
    && python3 tools/check_release_archive.py "release/bartizan-$BARTIZAN_VERSION-linux-x64.tar.gz" "$BARTIZAN_VERSION"
