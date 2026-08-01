"""Turning a PipeWire screen stream into a small grid of pixels.

GStreamer does all the heavy lifting. By the time a frame reaches Python it has
already been scaled from whatever the monitor is down to a grid of roughly
64x36, so each frame is a few kilobytes and per-frame numpy work is negligible.
Doing the downscale in Python instead would burn a core at 60 fps.

Frames arrive on GStreamer's own streaming thread, never the GTK thread. The
callback must therefore not touch widgets -- it feeds the streaming engine,
which is exactly where the data needs to go anyway.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

import gi
import numpy as np

gi.require_version("Gst", "1.0")
gi.require_version("GstApp", "1.0")

from gi.repository import Gst  # noqa: E402

from brightbulb.capture.portal import CaptureSource  # noqa: E402

_LOGGER = logging.getLogger(__name__)

# RGBx rather than RGB: 4-byte pixels keep rows naturally aligned, which avoids
# the padded-stride path in most cases and costs nothing at this size.
_BYTES_PER_PIXEL = 4

FrameCallback = Callable[[np.ndarray], None]

_initialised = False


def ensure_gstreamer() -> None:
    global _initialised
    if not _initialised:
        Gst.init(None)
        _initialised = True


class CapturePipeline:
    """Feeds downscaled frames from a portal stream to a callback."""

    def __init__(
        self,
        source: CaptureSource,
        on_frame: FrameCallback,
        width: int = 64,
        height: int = 36,
        fps: int = 60,
        on_error: Callable[[str], None] | None = None,
    ) -> None:
        ensure_gstreamer()
        self._source = source
        self._on_frame = on_frame
        self._on_error = on_error
        self._width = width
        self._height = height
        self._fps = fps
        self._pipeline: Gst.Pipeline | None = None
        self._watch_id: int | None = None
        self.frames_seen = 0

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        if self._pipeline is not None:
            return

        pipeline = Gst.parse_launch(self._describe())
        sink = pipeline.get_by_name("out")
        sink.set_property("emit-signals", True)
        sink.connect("new-sample", self._on_sample)

        bus = pipeline.get_bus()
        bus.add_signal_watch()
        self._watch_id = bus.connect("message", self._on_message)

        self._pipeline = pipeline
        if pipeline.set_state(Gst.State.PLAYING) is Gst.StateChangeReturn.FAILURE:
            self.stop()
            raise RuntimeError("could not start the capture pipeline")

    def stop(self) -> None:
        """Tear the pipeline down. The portal session and its fd stay valid.

        There is deliberately no pause/resume pair. ``pipewiresrc`` does not
        come back from ``PAUSED``: it goes quiet as expected and then delivers
        nothing at all once set back to ``PLAYING``, so mirroring restarted that
        way sits at 0 fps forever. Building a fresh pipeline on the same fd
        costs nothing noticeable and leaves the portal session untouched, so the
        user is still never re-prompted.
        """
        pipeline, self._pipeline = self._pipeline, None
        if pipeline is None:
            return
        bus = pipeline.get_bus()
        if self._watch_id is not None:
            bus.disconnect(self._watch_id)
            self._watch_id = None
        bus.remove_signal_watch()
        pipeline.set_state(Gst.State.NULL)

    @property
    def running(self) -> bool:
        return self._pipeline is not None

    # -- construction ------------------------------------------------------

    def _describe(self) -> str:
        # Target the stream by its PipeWire serial where the portal offers one:
        # node ids are recycled when a node is destroyed, so a stale id can
        # silently attach to the wrong source.
        target = self._source.target
        selector = f" target-object={target}" if target else f" path={self._source.node_id}"

        return (
            f"pipewiresrc fd={self._source.fd}{selector} do-timestamp=true"
            f" ! videorate drop-only=true"
            f" ! video/x-raw,framerate={self._fps}/1"
            f" ! videoconvert"
            f" ! videoscale method=2"
            f" ! video/x-raw,format=RGBx,width={self._width},height={self._height}"
            # Never let a slow consumer build a backlog: for mirroring, the
            # newest frame is the only one that matters.
            f" ! appsink name=out max-buffers=2 drop=true sync=false"
        )

    # -- frame delivery ----------------------------------------------------

    def _on_sample(self, sink: Any) -> Gst.FlowReturn:
        sample = sink.emit("pull-sample")
        if sample is None:
            return Gst.FlowReturn.OK

        buffer = sample.get_buffer()
        ok, info = buffer.map(Gst.MapFlags.READ)
        if not ok:
            return Gst.FlowReturn.OK

        try:
            frame = self._to_array(sample, info)
            if frame is not None:
                self.frames_seen += 1
                self._on_frame(frame)
        except Exception:
            _LOGGER.exception("error handling captured frame")
        finally:
            buffer.unmap(info)

        return Gst.FlowReturn.OK

    def _to_array(self, sample: Gst.Sample, info: Gst.MapInfo) -> np.ndarray | None:
        structure = sample.get_caps().get_structure(0)
        ok_w, width = structure.get_int("width")
        ok_h, height = structure.get_int("height")
        if not (ok_w and ok_h):
            return None
        return unpack_rgbx(np.frombuffer(info.data, dtype=np.uint8), width, height)

    # -- bus ---------------------------------------------------------------

    def _on_message(self, _bus: Gst.Bus, message: Gst.Message) -> None:
        if message.type is Gst.MessageType.ERROR:
            error, debug = message.parse_error()
            _LOGGER.error("capture pipeline error: %s (%s)", error.message, debug)
            if self._on_error is not None:
                self._on_error(error.message)
        elif message.type is Gst.MessageType.EOS:
            _LOGGER.info("capture stream ended")
            if self._on_error is not None:
                self._on_error("the screen share ended")


def unpack_rgbx(raw: np.ndarray, width: int, height: int) -> np.ndarray | None:
    """Reshape a raw RGBx buffer into an ``(height, width, 3)`` RGB array.

    GStreamer pads each row up to an alignment boundary, so a buffer is often
    larger than ``width * height * 4``. Those padding bytes are not image data;
    folding them in would tint every frame, and because the result still *looks*
    like a plausible image the mistake is easy to miss. Split out from the
    pipeline so this can be tested without a live capture.
    """
    if width <= 0 or height <= 0:
        return None

    row_bytes = width * _BYTES_PER_PIXEL
    if raw.size == row_bytes * height:
        pixels = raw.reshape(height, width, _BYTES_PER_PIXEL)
    else:
        stride = raw.size // height
        if stride < row_bytes:
            return None  # truncated buffer; better no frame than a garbled one
        rows = raw[: stride * height].reshape(height, stride)
        pixels = rows[:, :row_bytes].reshape(height, width, _BYTES_PER_PIXEL)

    # Copy: the caller unmaps the underlying buffer as soon as this returns.
    return pixels[:, :, :3].copy()


def source_from_fd(fd: int, node_id: int, serial: int | None = None) -> CaptureSource:
    """Build a CaptureSource by hand, for tests and manual pipeline checks."""
    return CaptureSource(
        fd=fd, node_id=node_id, serial=serial, width=0, height=0, restore_token=None
    )


__all__ = ["CapturePipeline", "ensure_gstreamer", "source_from_fd"]
