SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.ONESHELL:
PYTHON ?= python3
DEB_DISTRIBUTION ?= $(shell . /etc/os-release; echo "$${VERSION_CODENAME:-unstable}")
DEB_REVISION ?= 1~$(DEB_DISTRIBUTION)

define prepare
test "$$(uname -sm)" = 'Linux x86_64'
version=$$("$(PYTHON)" tools/version.py)
export BARTIZAN_VERSION="$$version"
archive="$${BARTIZAN_ARCHIVE:-release/bartizan-$$version-linux-x64.tar.gz}"
epoch=$$("$(PYTHON)" tools/check_release_archive.py "$$archive" "$$version")
export SOURCE_DATE_EPOCH=$${SOURCE_DATE_EPOCH:-$$epoch}
output="$$PWD/build/packages/$@$(if $(filter deb,$@),/$(DEB_DISTRIBUTION))"
mkdir -p "$$output"
endef

.PHONY: arch deb
arch:
	command -v makepkg >/dev/null
	command -v fakeroot >/dev/null
	$(prepare)
	cp packaging/arch/PKGBUILD "$$output/"
	filename="bartizan-$$version-linux-x64.tar.gz"
	test "$$archive" -ef "$$output/$$filename" || cp -- "$$archive" "$$output/$$filename"
	export BARTIZAN_ARCHIVE_SHA256=$$(sha256sum "$$output/$$filename" | cut -d' ' -f1)
	cd "$$output"
	makepkg --force --cleanbuild --nosign "PKGDEST=$$output" PKGEXT=.pkg.tar.zst

deb:
	command -v dpkg-buildpackage >/dev/null
	command -v dch >/dev/null
	$(prepare)
	source="$$output/bartizan-$$version"
	$(PYTHON) -c 'import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)' "$$source"
	mkdir -p "$$source/payload"
	tar --no-same-owner --strip-components=1 -C "$$source/payload" -xzf "$$archive"
	cp -R packaging/debian "$$source/debian"
	cd "$$source"
	cp payload/LICENSE debian/copyright
	DEBEMAIL="$$(dpkg-parsechangelog -S Maintainer)" dch --no-auto-nmu --preserve --newversion "$$version-$(DEB_REVISION)" --distribution '$(DEB_DISTRIBUTION)' "Bartizan $$version."
	dpkg-buildpackage --build=binary --no-sign
