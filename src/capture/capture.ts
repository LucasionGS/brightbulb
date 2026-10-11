/**
 * Portal capture fallback: grabs the screen chosen in the system dialog,
 * scales each frame down to the sampling grid and posts the pixels to the
 * sync process.
 */

interface CaptureOptions {
  width: number;
  height: number;
  fps: number;
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.type !== "capture-port") return;
  const port = event.ports[0];
  if (port) void capture(port, event.data as CaptureOptions);
});

async function capture(port: MessagePort, { width, height, fps }: CaptureOptions): Promise<void> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps }, audio: false });
  } catch {
    port.postMessage({ type: "ended", message: "Screen sharing was cancelled." });
    return;
  }

  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = stream;
  await video.play();

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.imageSmoothingQuality = "high";

  const timer = setInterval(() => {
    if (video.readyState < 2) return;
    context.drawImage(video, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    const rgba = new Uint8Array(data.buffer);
    port.postMessage({ type: "frame", width, height, rgba }, [rgba.buffer]);
  }, 1000 / fps);

  stream.getVideoTracks()[0]?.addEventListener("ended", () => {
    clearInterval(timer);
    port.postMessage({ type: "ended", message: "The screen share ended." });
  });
}
