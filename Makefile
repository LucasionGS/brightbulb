# BrightBulb build and install.
#
# The app ships as an app.asar run by the system Electron (on Arch, the
# `electron43` package), so the package carries no Chromium of its own.
#
#   make                      # npm ci + build the asar into out/
#   make install DESTDIR=...  # install it with a launcher, desktop file and icon
#   make check                # lint, type-check and test

PREFIX ?= /usr/local
DESTDIR ?=
# The Electron binary the launcher runs. Must match the major version in package.json.
ELECTRON ?= electron43
APP_ID := io.github.brightbulb.BrightBulb
LIBDIR := $(DESTDIR)$(PREFIX)/lib/brightbulb

.PHONY: all build deps check install uninstall clean

all: build

deps:
	npm ci

build: deps
	npx electron-forge package
	@test -f "$$(ls out/*/resources/app.asar | head -1)" || { echo "Build failed: no app.asar in out/"; exit 1; }

check:
	npm run lint
	npm run typecheck
	npm test

install:
	@asar="$$(ls out/*/resources/app.asar 2>/dev/null | head -1)"; \
	if [ -z "$$asar" ]; then echo "Nothing to install. Run make first."; exit 1; fi; \
	install -Dm644 "$$asar" "$(LIBDIR)/app.asar"
	install -d "$(DESTDIR)$(PREFIX)/bin"
	printf '#!/bin/sh\nexec %s %s/lib/brightbulb/app.asar "$$@"\n' "$(ELECTRON)" "$(PREFIX)" > "$(DESTDIR)$(PREFIX)/bin/brightbulb"
	chmod 755 "$(DESTDIR)$(PREFIX)/bin/brightbulb"
	install -Dm644 data/$(APP_ID).desktop "$(DESTDIR)$(PREFIX)/share/applications/$(APP_ID).desktop"
	install -Dm644 data/$(APP_ID).svg "$(DESTDIR)$(PREFIX)/share/icons/hicolor/scalable/apps/$(APP_ID).svg"
	install -Dm644 LICENSE "$(DESTDIR)$(PREFIX)/share/licenses/brightbulb/LICENSE"

uninstall:
	rm -f "$(DESTDIR)$(PREFIX)/bin/brightbulb"
	rm -rf "$(LIBDIR)"
	rm -f "$(DESTDIR)$(PREFIX)/share/applications/$(APP_ID).desktop"
	rm -f "$(DESTDIR)$(PREFIX)/share/icons/hicolor/scalable/apps/$(APP_ID).svg"
	rm -rf "$(DESTDIR)$(PREFIX)/share/licenses/brightbulb"

clean:
	rm -rf out .vite dist-test
