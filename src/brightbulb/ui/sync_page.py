"""The Sync page: mirror a screen onto an entertainment area.

Owns the whole mirroring lifecycle, in this order:

    pick area -> activate over CLIP -> portal capture -> DTLS -> send loop

Order matters. The entertainment configuration must be active before the DTLS
handshake, and it must be released afterwards or every other Hue app -- the
official one included -- is locked out until the bridge times it out. Teardown
therefore runs on every exit path.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
from collections.abc import Callable
from concurrent.futures import Future
from typing import TYPE_CHECKING, Any

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")

import brightbulb_dtls  # noqa: E402
from gi.repository import Adw, GLib, Gtk  # noqa: E402

from brightbulb.asyncio_bridge import call_on_ui  # noqa: E402
from brightbulb.capture.pipeline import CapturePipeline  # noqa: E402
from brightbulb.capture.portal import CaptureSource, ScreenCastPortal  # noqa: E402
from brightbulb.color.process import ProcessingSettings  # noqa: E402
from brightbulb.hue import entertainment  # noqa: E402
from brightbulb.stream.engine import StreamEngine  # noqa: E402
from brightbulb.stream.mapper import MappingConfig  # noqa: E402

if TYPE_CHECKING:
    from brightbulb.app import BrightBulbApplication

_LOGGER = logging.getLogger(__name__)


class SyncPage(Adw.Bin):
    """Controls and status for screen mirroring."""

    def __init__(self, app: BrightBulbApplication) -> None:
        super().__init__()
        self.app = app

        self._areas: list[entertainment.EntertainmentArea] = []
        self._portal: ScreenCastPortal | None = None
        self._source: CaptureSource | None = None
        self._pipeline: CapturePipeline | None = None
        self._engine: StreamEngine | None = None
        self._active_area_id: str | None = None
        self._starting = False
        self._status_timer = 0
        # In-flight deactivation, so a restart waits for it rather than racing.
        self._release: Future[None] | None = None
        # Our own streamer id, learnt the first time we claim the area.
        self._streamer_rid: str | None = None
        # Notified whenever mirroring starts, stops or changes status, so the
        # tray can follow along without polling.
        self.on_state_change: Callable[[], None] | None = None

        self._build()

    # -- construction ------------------------------------------------------

    def _build(self) -> None:
        page = Adw.PreferencesPage()

        # -- area + start ---------------------------------------------------
        group = Adw.PreferencesGroup(
            title="Screen mirroring",
            description="Stream your screen's colours to a Hue entertainment area.",
        )

        self._area_row = Adw.ComboRow(title="Entertainment area", model=Gtk.StringList())
        self._area_row.connect("notify::selected", self._on_area_changed)
        group.add(self._area_row)

        # Which screen is being captured. The portal remembers the choice
        # between sessions, so without a way to change it the user would be
        # stuck with whatever they picked once, possibly on another machine or
        # before they plugged in a different monitor.
        self._screen_row = Adw.ActionRow(
            title="Screen", subtitle="Chosen when mirroring starts"
        )
        self._screen_row.add_prefix(Gtk.Image(icon_name="video-display-symbolic"))
        change_button = Gtk.Button(label="Change…", valign=Gtk.Align.CENTER)
        change_button.set_tooltip_text("Forget the remembered screen and pick again")
        change_button.connect("clicked", lambda *_: self._change_screen())
        self._screen_row.add_suffix(change_button)
        group.add(self._screen_row)

        self._status_row = Adw.ActionRow(title="Status", subtitle="Not running")
        self._spinner = Adw.Spinner(visible=False, width_request=18, height_request=18)
        self._status_row.add_prefix(self._spinner)

        self._toggle = Gtk.Switch(valign=Gtk.Align.CENTER)
        self._toggle.connect("notify::active", self._on_toggled)
        self._status_row.add_suffix(self._toggle)
        group.add(self._status_row)
        page.add(group)

        # -- look -----------------------------------------------------------
        appearance = Adw.PreferencesGroup(
            title="Appearance",
            description="Changes apply immediately while mirroring.",
        )
        sync = self.app.settings.sync
        self._brightness = self._slider(
            appearance, "Brightness", 0.1, 1.5, sync.brightness
        )
        self._saturation = self._slider(
            appearance, "Saturation", 0.5, 2.5, sync.saturation
        )
        self._smoothing = self._slider(
            appearance, "Smoothing", 0.0, 0.95, 1.0 - sync.attack,
            subtitle="Higher is calmer, lower reacts faster",
        )
        page.add(appearance)

        # -- room layout ------------------------------------------------------
        layout = Adw.PreferencesGroup(
            title="Room layout",
            description=(
                "Which end of the room your screen is at. If your lights mirror "
                "the wrong way round, switch this."
            ),
        )
        self._flip_row = Adw.SwitchRow(
            title="Screen is at the far end",
            subtitle="Flips which lights follow their own part of the screen",
            active=sync.screen_at_positive_y,
        )
        self._flip_row.connect("notify::active", self._on_layout_changed)
        layout.add(self._flip_row)
        page.add(layout)

        self.set_child(page)

    def _slider(
        self,
        group: Adw.PreferencesGroup,
        title: str,
        lower: float,
        upper: float,
        value: float,
        subtitle: str | None = None,
    ) -> Gtk.Scale:
        scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, lower, upper, 0.01)
        scale.set_value(value)
        scale.set_hexpand(True)
        scale.set_draw_value(False)
        scale.set_size_request(240, -1)
        scale.connect("value-changed", self._on_appearance_changed)

        row = Adw.ActionRow(title=title, subtitle=subtitle)
        row.add_suffix(scale)
        group.add(row)
        return scale

    # -- bridge state ------------------------------------------------------

    def refresh(self, bridge: Any) -> None:
        """Repopulate the area list. Called on the GTK thread."""
        self._areas = entertainment.list_areas(bridge)

        model = Gtk.StringList()
        for area in self._areas:
            label = f"{area.name} · {len(area.channels)} lights"
            if area.configuration_type.lower() == "screen":
                label += " · for screens"
            model.append(label)
        self._area_row.set_model(model)

        chosen = self.app.settings.sync.entertainment_id
        index = next(
            (i for i, area in enumerate(self._areas) if area.id == chosen), None
        )
        if index is None:
            preferred = entertainment.preferred_area(self._areas)
            index = self._areas.index(preferred) if preferred else 0
        if self._areas:
            self._area_row.set_selected(index)

        self._toggle.set_sensitive(bool(self._areas))
        if not self._areas:
            self._status_row.set_subtitle(
                "No entertainment areas. Create one in the Hue app first."
            )
        # Areas arriving is what makes mirroring possible, so anything mirroring
        # the toggle's state -- the tray menu -- needs to hear about it. Hosts
        # that never call AboutToShow would otherwise show it greyed out.
        if self.on_state_change is not None:
            self.on_state_change()

    def _selected_area(self) -> entertainment.EntertainmentArea | None:
        index = self._area_row.get_selected()
        if 0 <= index < len(self._areas):
            return self._areas[index]
        return None

    # -- settings ----------------------------------------------------------

    def _on_area_changed(self, *_: object) -> None:
        area = self._selected_area()
        if area is not None:
            self.app.settings.sync.entertainment_id = area.id

    def _on_appearance_changed(self, *_: object) -> None:
        sync = self.app.settings.sync
        sync.brightness = self._brightness.get_value()
        sync.saturation = self._saturation.get_value()
        # One "smoothing" control is friendlier than exposing attack and decay
        # separately; decay stays slower than attack so fades never flicker.
        sync.attack = max(0.05, 1.0 - self._smoothing.get_value())
        sync.decay = sync.attack * 0.25

        if self._engine is not None:
            self._engine.processor.settings = self._processing()

    def _on_layout_changed(self, *_: object) -> None:
        self.app.settings.sync.screen_at_positive_y = self._flip_row.get_active()
        if self._engine is not None:
            # Rebuilding the mapper is cheap and gives instant feedback, which
            # is what makes this control usable at all.
            area = self._selected_area()
            if area is not None:
                self._engine.mapper = self._build_mapper(area)

    def _processing(self) -> ProcessingSettings:
        sync = self.app.settings.sync
        return ProcessingSettings(
            brightness=sync.brightness,
            saturation=sync.saturation,
            attack=sync.attack,
            decay=sync.decay,
        )

    def _mapping(self) -> MappingConfig:
        return MappingConfig(
            screen_at_positive_y=self.app.settings.sync.screen_at_positive_y
        )

    def _build_mapper(self, area: entertainment.EntertainmentArea) -> Any:
        from brightbulb.stream.mapper import ScreenMapper

        sync = self.app.settings.sync
        return ScreenMapper(
            area.channels, sync.grid_width, sync.grid_height, self._mapping()
        )

    # -- start / stop ------------------------------------------------------

    def _on_toggled(self, *_: object) -> None:
        if self._toggle.get_active():
            if not self._starting and self._engine is None:
                self._start()
        else:
            self._stop()

    def _start(self) -> None:
        area = self._selected_area()
        if area is None:
            return

        self._starting = True
        self._set_status("Preparing…", busy=True)

        # Reuse an existing capture: re-negotiating would prompt again on
        # compositors that do not hand out restore tokens.
        if self._source is not None:
            self._activate(area)
            return

        self._negotiate(then=lambda: self._activate(area))

    def _negotiate(
        self,
        then: Callable[[], None],
        forget: bool = False,
        on_cancel: Callable[[], None] | None = None,
    ) -> None:
        """Ask the portal for a screen, then run ``then``.

        With ``forget`` the stored restore token is left out of the request,
        which is what makes the compositor prompt again instead of silently
        handing back the previously chosen screen.
        """
        self._set_status("Waiting for screen selection…", busy=True)
        token = None if forget else self.app.settings.sync.screencast_restore_token

        self._portal = ScreenCastPortal()
        self._portal.start(
            on_ready=lambda source: self._on_capture_ready(source, then),
            on_error=lambda err: self._negotiation_failed(err, on_cancel),
            restore_token=token,
            parent_window="",
        )

    def _negotiation_failed(
        self, error: Exception, on_cancel: Callable[[], None] | None
    ) -> None:
        if on_cancel is not None:
            on_cancel()
        self._fail(_describe_portal_error(error))

    def _change_screen(self) -> None:
        """Forget the remembered screen and pick a new one."""
        was_running = self._engine is not None

        # A portal session is bound to the screen it was granted for, so the old
        # one has to go entirely -- pausing is not enough.
        self._stop()
        self._release_capture()

        self.app.settings.sync.screencast_restore_token = None
        self.app.settings.save()

        def resume() -> None:
            self._describe_screen()
            if was_running:
                # Was mirroring before, so pick straight back up on the new
                # screen rather than making the user flip the switch again.
                self._starting = False
                self._toggle.set_active(True)
            else:
                self._starting = False
                self._set_status("Not running", busy=False)

        self._starting = True
        self._negotiate(then=resume, forget=True, on_cancel=self._describe_screen)

    def _release_capture(self) -> None:
        """Drop the pipeline and portal session, keeping settings intact."""
        if self._pipeline is not None:
            self._pipeline.stop()
            self._pipeline = None
        if self._portal is not None:
            self._portal.close()
            self._portal = None
        self._source = None

    def _describe_screen(self) -> None:
        source = self._source
        if source is None:
            self._screen_row.set_subtitle("Chosen when mirroring starts")
        elif source.width and source.height:
            self._screen_row.set_subtitle(
                f"{source.width}x{source.height} · remembered for next time"
            )
        else:
            self._screen_row.set_subtitle("Selected · remembered for next time")

    def _on_capture_ready(
        self, source: CaptureSource, then: Callable[[], None]
    ) -> None:
        self._source = source
        self._describe_screen()
        if source.restore_token:
            # Always overwrite: portals differ on whether tokens rotate, and
            # storing a stale one silently reintroduces the prompt.
            self.app.settings.sync.screencast_restore_token = source.restore_token
            self.app.settings.save()
        then()

    def _activate(self, area: entertainment.EntertainmentArea) -> None:
        """Claim the area over CLIP, then connect. Runs the async part off-thread."""
        bridge = self.app.bridge.bridge
        if bridge is None:
            self._fail("Not connected to the bridge.")
            return

        self._set_status("Claiming the entertainment area…", busy=True)
        release, self._release = self._release, None
        self.app.runner.run_and_then(
            self._claim(bridge, area.id, release),
            on_done=lambda state: self._claimed(area, state),
            on_error=lambda err: self._fail(f"Could not start the area: {err}"),
        )

    async def _claim(
        self,
        bridge: Any,
        area_id: str,
        release: Future[None] | None,
    ) -> entertainment.StreamingState:
        """Take ownership of the area and report who ended up holding it."""
        if release is not None:
            # Turning mirroring off and straight back on leaves the previous
            # release still in flight; claiming first would let it land
            # afterwards and hand the area back mid-stream.
            with contextlib.suppress(Exception):
                await asyncio.wrap_future(release)

        await entertainment.start_streaming(bridge, area_id)
        return await entertainment.streaming_state(bridge, area_id)

    def _claimed(
        self, area: entertainment.EntertainmentArea, state: entertainment.StreamingState
    ) -> None:
        if not state.active:
            self._fail("The bridge did not hand over the entertainment area.")
            return

        if self._streamer_rid and state.streamer_rid != self._streamer_rid:
            # Only reachable once we have streamed and learnt our own id, so
            # this cannot misfire on our own claim.
            self._fail("Another app is already streaming to this area.")
            return

        # Whoever holds the area immediately after our own start is us. There is
        # no other way to learn the id: the auth resource is not readable.
        self._streamer_rid = state.streamer_rid
        self._connect(area)

    def _connect(self, area: entertainment.EntertainmentArea) -> None:
        self._active_area_id = area.id
        self._set_status("Connecting…", busy=True)

        settings = self.app.settings
        app_key = self.app.secrets.lookup(settings.bridge_id or "", "app_key")
        client_key = self.app.bridge.client_key
        if not app_key or not client_key:
            self._fail("Missing bridge credentials. Pair with the bridge again.")
            return

        # The handshake takes about a second of blocking network I/O; running it
        # on the GTK thread would freeze the window for that whole time.
        threading.Thread(
            target=self._handshake_worker,
            args=(settings.bridge_host, app_key, client_key, area),
            name="brightbulb-handshake",
            daemon=True,
        ).start()

    def _handshake_worker(
        self, host: str, app_key: str, client_key: str, area: Any
    ) -> None:
        try:
            stream = brightbulb_dtls.HueStream(host, app_key, client_key)
        except Exception as err:
            call_on_ui(self._fail, f"Streaming connection failed: {err}")
            return
        call_on_ui(self._begin_streaming, stream, area)

    def _begin_streaming(self, stream: Any, area: entertainment.EntertainmentArea) -> None:
        sync = self.app.settings.sync
        engine = StreamEngine(
            transport=stream,
            entertainment_id=area.id,
            channels=area.channels,
            grid_width=sync.grid_width,
            grid_height=sync.grid_height,
            fps=sync.target_fps,
            processing=self._processing(),
            mapping=self._mapping(),
            on_error=lambda message: call_on_ui(self._fail, message),
        )
        engine.start()
        self._engine = engine

        assert self._source is not None
        # A fresh pipeline every time, on the same portal fd. Reusing a stopped
        # one is not possible and pausing one is worse -- see CapturePipeline.stop.
        self._pipeline = CapturePipeline(
            self._source,
            on_frame=engine.submit_frame,
            width=sync.grid_width,
            height=sync.grid_height,
            fps=sync.target_fps,
            on_error=lambda message: call_on_ui(self._fail, message),
        )
        self._pipeline.start()

        self._starting = False
        self._set_status("Mirroring", busy=False)
        self._status_timer = GLib.timeout_add_seconds(1, self._tick_status)

    def _stop(self) -> None:
        self._starting = False
        if self._status_timer:
            GLib.source_remove(self._status_timer)
            self._status_timer = 0

        engine, self._engine = self._engine, None
        if engine is not None:
            engine.stop()
            engine.close_transport()

        if self._pipeline is not None:
            # The portal session and its fd outlive the pipeline, so restarting
            # builds a new one without prompting for a screen again.
            self._pipeline.stop()
            self._pipeline = None

        area_id, self._active_area_id = self._active_area_id, None
        bridge = self.app.bridge.bridge
        if area_id and bridge is not None:
            # Always release: an area left active locks out every other Hue app.
            self._release = self.app.runner.run_and_then(
                entertainment.stop_streaming(bridge, area_id)
            )

        self._set_status("Not running", busy=False)

    def shutdown(self) -> None:
        """Tear everything down, including the portal session."""
        self._stop()
        self._release_capture()

    # -- status ------------------------------------------------------------

    def _tick_status(self) -> bool:
        engine = self._engine
        if engine is None:
            return GLib.SOURCE_REMOVE
        stats = engine.stats
        self._set_status(
            f"Mirroring · {stats.measured_fps:.0f} fps · "
            f"{len(engine.mapper.channels)} lights",
            busy=False,
        )
        return GLib.SOURCE_CONTINUE

    def _set_status(self, message: str, busy: bool) -> None:
        self._status_row.set_subtitle(message)
        self._spinner.set_visible(busy)
        if self.on_state_change is not None:
            self.on_state_change()

    # -- external control --------------------------------------------------

    @property
    def mirroring(self) -> bool:
        """True while mirroring is running or coming up."""
        return self._engine is not None or self._starting

    @property
    def can_mirror(self) -> bool:
        return bool(self._areas)

    def set_mirroring(self, active: bool) -> None:
        """Start or stop mirroring from outside, e.g. the tray menu."""
        self._toggle.set_active(active)

    def status_text(self) -> str:
        return str(self._status_row.get_subtitle() or "")

    def _fail(self, message: str) -> None:
        _LOGGER.warning("mirroring failed: %s", message)
        self._stop()
        self._toggle.set_active(False)
        self._set_status(message, busy=False)


def _describe_portal_error(error: Exception) -> str:
    text = str(error)
    if "cancelled" in text.lower():
        return "Screen sharing was cancelled."
    return f"Screen capture failed: {text}"
