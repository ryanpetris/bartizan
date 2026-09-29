SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.ONESHELL:
PYTHON ?= python3
VERSION := $(shell $(PYTHON) tools/version.py)
ifeq ($(VERSION),)
$(error Invalid BARTIZAN_VERSION)
endif
export BARTIZAN_VERSION := $(VERSION)
export SOURCE_DATE_EPOCH ?= $(shell git log -1 --format=%ct)

.PHONY: build check portable package arch deb mac clean
build:
	npm run build

check:
	npm run typecheck
	npm test
	$(PYTHON) -m unittest discover -s tools -p 'test_*.py'

portable:
	test "$$(uname -sm)" = 'Linux x86_64'
	docker build -f packaging/build.Dockerfile -t bartizan-package --build-arg BARTIZAN_VERSION --build-arg SOURCE_DATE_EPOCH .
	container=$$(docker create bartizan-package)
	trap 'docker rm "$$container" >/dev/null' EXIT
	mkdir -p release
	$(PYTHON) -c 'import shutil; shutil.rmtree("release/linux-unpacked", ignore_errors=True)'
	docker cp "$$container:/work/release/." release/
	$(PYTHON) tools/check_release_archive.py 'release/bartizan-$(VERSION)-linux-x64.tar.gz' '$(VERSION)'

package: portable

arch deb:
	$(MAKE) -f packaging/Makefile $@

mac: build
	test "$$(uname -sm)" = 'Darwin arm64'
	npx --no-install electron-builder --mac --arm64 --publish never --config.extraMetadata.version="$$BARTIZAN_VERSION"

clean:
	$(PYTHON) -c 'import shutil; [shutil.rmtree(path, ignore_errors=True) for path in ("out", "release", "build")]'
