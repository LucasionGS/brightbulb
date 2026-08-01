"""Persistent settings and credential storage.

Two stores with different security properties:

* :class:`Settings` -- plain JSON in ``$XDG_CONFIG_HOME/brightbulb/settings.json``
  for anything non-sensitive (which bridge, which entertainment area, sync
  preferences, the ScreenCast restore token).
* :class:`SecretStore` -- the bridge ``clientkey`` and app key are credentials
  that grant control of the user's lights, so they go to libsecret when a
  keyring is available, falling back to a 0600 file under
  ``$XDG_STATE_HOME/brightbulb`` when it is not (headless, no keyring daemon).
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import gi
from gi.repository import GLib

gi.require_version("Secret", "1")
from gi.repository import Secret  # noqa: E402

_LOGGER = logging.getLogger(__name__)

APP_ID = "io.github.brightbulb.BrightBulb"
APP_NAME = "BrightBulb"

_SECRET_SCHEMA = Secret.Schema.new(
    APP_ID,
    Secret.SchemaFlags.NONE,
    {"bridge_id": Secret.SchemaAttributeType.STRING, "kind": Secret.SchemaAttributeType.STRING},
)


def config_dir() -> Path:
    path = Path(GLib.get_user_config_dir()) / "brightbulb"
    path.mkdir(parents=True, exist_ok=True)
    return path


def state_dir() -> Path:
    path = Path(GLib.get_user_state_dir()) / "brightbulb"
    path.mkdir(parents=True, exist_ok=True)
    return path


@dataclass
class SyncSettings:
    """Screen-mirroring preferences."""

    entertainment_id: str | None = None
    # Capture grid resolution. GStreamer does the downscale, so finer grids cost
    # almost nothing in Python but do sharpen position-aware sampling.
    grid_width: int = 64
    grid_height: int = 36
    target_fps: int = 60
    brightness: float = 1.0
    saturation: float = 1.2
    # Asymmetric smoothing: react fast to cuts, fade slowly, so scene changes
    # feel immediate without the lights flickering on noisy content.
    attack: float = 0.6
    decay: float = 0.15
    # Which end of the room the screen is at, in the bridge's coordinate space.
    # Hue's own docs are inconsistent about the sign, and it depends on how the
    # user arranged the area, so it is a setting rather than a constant.
    screen_at_positive_y: bool = False
    # Single-use token from org.freedesktop.portal.ScreenCast, replaced on every
    # successful Start. Without it the user is re-prompted on every launch.
    screencast_restore_token: str | None = None


@dataclass
class Settings:
    bridge_id: str | None = None
    bridge_host: str | None = None
    # Closing the window hides it to the tray instead of quitting, so screen
    # mirroring survives. Ignored when no tray host accepted our icon -- hiding
    # to a tray that is not there would leave no way back.
    close_to_tray: bool = True
    # Whether the "still running in the tray" notification has been shown. It is
    # only useful the first time; after that it is noise.
    tray_hint_shown: bool = False
    sync: SyncSettings = field(default_factory=SyncSettings)

    @classmethod
    def path(cls) -> Path:
        return config_dir() / "settings.json"

    @classmethod
    def load(cls) -> Settings:
        path = cls.path()
        if not path.exists():
            return cls()
        try:
            raw: dict[str, Any] = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            _LOGGER.exception("could not read %s; starting from defaults", path)
            return cls()
        sync = SyncSettings(**{k: v for k, v in raw.pop("sync", {}).items()
                               if k in SyncSettings.__dataclass_fields__})
        known = {k: v for k, v in raw.items() if k in cls.__dataclass_fields__}
        return cls(sync=sync, **known)

    def save(self) -> None:
        path = self.path()
        # Write-then-rename so a crash mid-write cannot truncate the settings.
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(asdict(self), indent=2))
        tmp.replace(path)


class SecretStore:
    """Stores per-bridge credentials, preferring libsecret."""

    def __init__(self) -> None:
        self._fallback = state_dir() / "credentials.json"

    def _attrs(self, bridge_id: str, kind: str) -> dict[str, str]:
        return {"bridge_id": bridge_id, "kind": kind}

    def store(self, bridge_id: str, kind: str, value: str) -> None:
        label = f"{APP_NAME}: Hue bridge {bridge_id} ({kind})"
        try:
            Secret.password_store_sync(
                _SECRET_SCHEMA, self._attrs(bridge_id, kind),
                Secret.COLLECTION_DEFAULT, label, value, None,
            )
            return
        except GLib.Error:
            _LOGGER.warning("libsecret unavailable; falling back to file storage", exc_info=True)
        self._store_fallback(bridge_id, kind, value)

    def lookup(self, bridge_id: str, kind: str) -> str | None:
        try:
            value = Secret.password_lookup_sync(_SECRET_SCHEMA, self._attrs(bridge_id, kind), None)
            if value:
                return str(value)
        except GLib.Error:
            _LOGGER.debug("libsecret lookup failed; trying file fallback", exc_info=True)
        return self._lookup_fallback(bridge_id, kind)

    def clear(self, bridge_id: str) -> None:
        for kind in ("app_key", "client_key"):
            try:
                Secret.password_clear_sync(_SECRET_SCHEMA, self._attrs(bridge_id, kind), None)
            except GLib.Error:
                _LOGGER.debug("libsecret clear failed for %s", kind, exc_info=True)
        data = self._read_fallback()
        if data.pop(bridge_id, None) is not None:
            self._write_fallback(data)

    # -- file fallback -----------------------------------------------------

    def _read_fallback(self) -> dict[str, dict[str, str]]:
        if not self._fallback.exists():
            return {}
        try:
            return json.loads(self._fallback.read_text())
        except (OSError, json.JSONDecodeError):
            _LOGGER.exception("could not read credential fallback %s", self._fallback)
            return {}

    def _write_fallback(self, data: dict[str, dict[str, str]]) -> None:
        tmp = self._fallback.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data))
        os.chmod(tmp, 0o600)
        tmp.replace(self._fallback)

    def _store_fallback(self, bridge_id: str, kind: str, value: str) -> None:
        data = self._read_fallback()
        data.setdefault(bridge_id, {})[kind] = value
        self._write_fallback(data)

    def _lookup_fallback(self, bridge_id: str, kind: str) -> str | None:
        return self._read_fallback().get(bridge_id, {}).get(kind)
