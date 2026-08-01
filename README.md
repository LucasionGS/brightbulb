# BrightBulb

An open source Philips Hue control center for Linux — control your lights, and
mirror your screen onto them in real time.

## Features

- **Discovery and pairing** over mDNS, with cloud discovery and manual IP entry
  as fallbacks. Credentials are stored in your keyring.
- **Light control** — power, brightness, colour and colour temperature, grouped
  by room, with only the controls each lamp actually supports.
- **Scenes**, grouped by the room they apply to, each previewing its palette.
- **Screen mirroring** to a Hue entertainment area, mapping every light to the
  part of your screen it physically sits next to.
- **Live updates** from the CLIP v2 event stream, so the UI never polls.

## Requirements

Linux with Wayland (X11 works, but screen capture is developed against the
xdg-desktop-portal ScreenCast interface). BrightBulb uses your system's
PyGObject and GStreamer rather than bundling them.

Screen mirroring needs a **v2 (square) Hue bridge** and an entertainment area
containing colour-capable lights.

## Installing

### Arch Linux (AUR)

```fish
paru -S brightbulb-git
```

`aiohue` and `asyncio-throttle` are not in the official repositories, so
BrightBulb also publishes `python-aiohue` and `python-asyncio-throttle`. Your
AUR helper pulls them in automatically.

### From source

```fish
sudo pacman -S --needed python python-gobject gtk4 libadwaita \
    gstreamer gst-plugins-base gst-plugin-pipewire gst-python \
    libsecret openssl rust uv

uv venv --system-site-packages   # PyGObject/GStreamer come from the system
uv sync
uv run brightbulb
```

Set `BRIGHTBULB_DEBUG=1` for verbose logging.

## Using it

Press the round button on your bridge when BrightBulb asks, and it pairs
itself. **Ctrl+1/2/3** switch between Lights, Scenes and Sync.

### Screen sharing prompts

The first time you start mirroring, your compositor asks which monitor to
share. BrightBulb requests a persistent permission, so **choose the option to
remember or allow restoring the selection** if your share picker offers one —
on Hyprland it is an explicit choice in `hyprland-share-picker`. Do that and
later launches reconnect without prompting at all.

If you decline, everything still works; you are just asked each time.
BrightBulb only negotiates once per run and pauses the pipeline when mirroring
stops, so you are never prompted twice in a session.

### Mirroring the wrong screen

Because the choice is remembered, a monitor picked in an earlier session keeps
being used — including one you have since unplugged, or picked on a different
setup. Press **Change…** next to *Screen* on the Sync page: it forgets the
stored selection and asks again, then resumes mirroring on the new screen if it
was already running.

### If the mirroring looks wrong way round

Lights are mapped using the positions you gave them in the Hue app's
entertainment area editor. If your left-hand lights follow the right of the
screen, flip **Screen is at the far end** on the Sync page — that changes which
end of the room BrightBulb treats as holding the screen.

If individual lights follow the wrong region, their coordinates in the Hue app
are probably not where they physically are; correcting them there fixes it
here.

## How it works

Almost all of BrightBulb is Python. The one exception is `crates/hue-stream`, a
small Rust extension providing DTLS-PSK.

That exists out of necessity rather than preference. The Hue Entertainment API
requires DTLS 1.2 with `TLS_PSK_WITH_AES_128_GCM_SHA256`, and no pure-Python
option can currently do it: `pyOpenSSL` exposes DTLS but has no PSK API at all,
and `python-mbedtls` last shipped wheels for CPython 3.12 built against
mbedTLS 2.28. System OpenSSL supports the cipher suite, so we reach it from
Rust and hand Python a three-method object.

The mirroring path is:

```
portal ScreenCast → PipeWire → GStreamer (scale to 64×36) → mapper → colour → DTLS
```

GStreamer does the downscaling, so Python only ever touches a few kilobytes per
frame. Colours are averaged in **linear light**, not gamma-encoded sRGB —
averaging encoded pixels makes dark scenes visibly too bright.

## Development

```fish
make check      # ruff, mypy, cargo clippy, pytest
make test
make lint
```

Packaging is driven by the `Makefile`; `make install` builds both wheels and
stages them, which is exactly what the AUR `PKGBUILD` calls.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

BrightBulb is not affiliated with or endorsed by Signify / Philips Hue.
