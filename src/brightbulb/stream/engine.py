"""The streaming loop: captured frames in, entertainment frames out.

Runs on its own thread with a monotonic pacer. It deliberately does not share a
thread with GTK -- a repaint stalling the send loop would show up directly as
stuttering lights -- nor with asyncio, whose scheduling granularity is a poor
match for a fixed 50-60 Hz cadence.

Frames arrive from GStreamer's thread and are dropped into a single slot rather
than a queue: when mirroring, the newest frame is the only one that matters, and
a queue would only add latency during a stall.

The loop also has to keep sending when nothing changes. The bridge drops a
stream that goes quiet for about ten seconds, so a frame is re-sent periodically
even on a static screen.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass

import numpy as np

from brightbulb.color.process import ColorProcessor, ProcessingSettings, to_linear, to_uint16
from brightbulb.hue.entertainment import ChannelPosition
from brightbulb.stream import protocol
from brightbulb.stream.mapper import MappingConfig, ScreenMapper

_LOGGER = logging.getLogger(__name__)

# Resend at least this often so the bridge does not time the stream out. Well
# inside the bridge's roughly ten second window.
_KEEPALIVE_SECONDS = 4.0

# Give up after this many consecutive send failures.
_MAX_CONSECUTIVE_ERRORS = 10


@dataclass
class EngineStats:
    frames_sent: int = 0
    frames_captured: int = 0
    measured_fps: float = 0.0
    last_error: str | None = None


class StreamTransport:
    """What the engine needs from a DTLS connection.

    Defined structurally so tests can substitute a recorder without a bridge.
    """

    def send(self, payload: bytes) -> None: ...  # pragma: no cover
    def close(self) -> None: ...  # pragma: no cover


class StreamEngine:
    """Drives the send loop for one entertainment area."""

    def __init__(
        self,
        transport: StreamTransport,
        entertainment_id: str,
        channels: Sequence[ChannelPosition],
        grid_width: int,
        grid_height: int,
        fps: int = 50,
        processing: ProcessingSettings | None = None,
        mapping: MappingConfig | None = None,
        on_error: Callable[[str], None] | None = None,
    ) -> None:
        self._transport = transport
        self._entertainment_id = entertainment_id
        self._fps = max(1, fps)
        self._on_error = on_error

        self.mapper = ScreenMapper(channels, grid_width, grid_height, mapping)
        self.processor = ColorProcessor(len(channels), processing)
        self.stats = EngineStats()

        self._channel_ids = self.mapper.channel_ids
        self._frame: np.ndarray | None = None
        self._frame_lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="brightbulb-stream", daemon=True
        )
        self._thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=timeout)

    def close_transport(self) -> None:
        """Close the DTLS connection. Call after :meth:`stop`."""
        try:
            self._transport.close()
        except Exception:
            # Teardown must not raise: the bridge times the session out anyway,
            # and this runs on shutdown and error paths.
            _LOGGER.debug("closing stream transport failed", exc_info=True)

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    # -- frame intake (called from the GStreamer thread) -------------------

    def submit_frame(self, frame: np.ndarray) -> None:
        """Offer the newest captured frame. Never blocks the capture thread."""
        with self._frame_lock:
            self._frame = frame
        self.stats.frames_captured += 1

    def _take_frame(self) -> np.ndarray | None:
        with self._frame_lock:
            return self._frame

    # -- the loop ----------------------------------------------------------

    def _run(self) -> None:
        interval = 1.0 / self._fps
        start = time.monotonic()
        sent = 0
        errors = 0
        last_payload: bytes | None = None
        last_send = 0.0
        sequence = 0

        while not self._stop.is_set():
            now = time.monotonic()
            frame = self._take_frame()

            payload: bytes | None = None
            if frame is not None:
                colors = self.processor.process(self.mapper.sample(to_linear(frame)))
                values = to_uint16(colors)
                payload = protocol.build_frame(
                    self._entertainment_id,
                    [
                        (channel_id, int(v[0]), int(v[1]), int(v[2]))
                        for channel_id, v in zip(self._channel_ids, values, strict=True)
                    ],
                    sequence=sequence,
                )
                last_payload = payload
            elif last_payload is not None and now - last_send >= _KEEPALIVE_SECONDS:
                # Nothing new to show, but silence would cost us the stream.
                payload = last_payload

            if payload is not None:
                try:
                    self._transport.send(payload)
                    errors = 0
                    sent += 1
                    sequence = (sequence + 1) & 0xFF
                    last_send = now
                except Exception as err:
                    errors += 1
                    self.stats.last_error = str(err)
                    _LOGGER.debug("send failed (%d in a row): %s", errors, err)
                    if errors >= _MAX_CONSECUTIVE_ERRORS:
                        message = f"streaming stopped: {err}"
                        _LOGGER.error(message)
                        if self._on_error is not None:
                            self._on_error(message)
                        break

            self.stats.frames_sent = sent
            elapsed = time.monotonic() - start
            if elapsed > 0:
                self.stats.measured_fps = sent / elapsed

            # Pace against absolute time so scheduling jitter does not
            # accumulate into a slow drift away from the target rate.
            target = start + sent * interval
            delay = target - time.monotonic()
            if delay > 0:
                self._stop.wait(min(delay, interval))
            elif delay < -interval * 10:
                # Fell far behind (suspend, or a stalled bridge); rebase rather
                # than sprinting to catch up with stale frames.
                start = time.monotonic()
                sent = 0
