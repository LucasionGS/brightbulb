# Build and install BrightBulb.
#
# The AUR PKGBUILD drives `make install` with DESTDIR/PREFIX, so everything the
# package needs has to happen here. Two wheels are built: the Rust extension in
# crates/hue-stream, then the Python application.
#
# Wheels are installed with `python -m installer` rather than pip, which is the
# Arch convention: it unpacks into DESTDIR without touching the network or
# trying to resolve dependencies the distro package already declares.

PREFIX  ?= /usr
DESTDIR ?=
PYTHON  ?= python3
APP_ID  := io.github.brightbulb.BrightBulb

DIST_APP  := dist
DIST_DTLS := crates/hue-stream/dist

.PHONY: all build build-dtls build-app install install-data clean dev test lint check

all: build

# -- building ---------------------------------------------------------------

build: build-dtls build-app

build-dtls:
	$(PYTHON) -m build --wheel --no-isolation --outdir $(DIST_DTLS) crates/hue-stream

build-app:
	$(PYTHON) -m build --wheel --no-isolation --outdir $(DIST_APP) .

# -- installing -------------------------------------------------------------

install: build install-data
	$(PYTHON) -m installer --destdir="$(DESTDIR)" --prefix="$(PREFIX)" $(DIST_DTLS)/*.whl
	$(PYTHON) -m installer --destdir="$(DESTDIR)" --prefix="$(PREFIX)" $(DIST_APP)/*.whl

install-data:
	install -Dm644 data/$(APP_ID).desktop \
		"$(DESTDIR)$(PREFIX)/share/applications/$(APP_ID).desktop"
	install -Dm644 data/$(APP_ID).svg \
		"$(DESTDIR)$(PREFIX)/share/icons/hicolor/scalable/apps/$(APP_ID).svg"
	install -Dm644 LICENSE \
		"$(DESTDIR)$(PREFIX)/share/licenses/brightbulb/LICENSE"

clean:
	rm -rf $(DIST_APP) $(DIST_DTLS) build *.egg-info
	rm -rf crates/hue-stream/target

# -- development ------------------------------------------------------------

dev:
	uv sync

test:
	uv run pytest -q

lint:
	uv run ruff check .
	uv run mypy
	cd crates/hue-stream && cargo clippy --release -- -D warnings

check: lint test
