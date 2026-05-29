// =============================================================================
// lib/video-compression.js — Client-side verification video compression
// =============================================================================
// Re-encodes the seller's source video to a much smaller file before upload,
// so admin review egress (which dominates cost at our scale) stays cheap and
// we can allow longer source clips. Targets ~720p / ~600 kbps which keeps
// the artwork + handwritten card readable while shrinking a typical 25MB
// iPhone HD clip down to ~3-5MB.
//
// Browser support:
//   - Chrome / Edge (desktop + Android): full support since 2016.
//   - Firefox: full support since 2017.
//   - Samsung Internet: supported.
//   - Safari (iOS + macOS): supported on 14.1+ (2021). Older Safari falls
//     back to the no-compression path in the caller — see isSupported().
//
// Codec selection is preference-ordered. We try webm/vp9, then webm/vp8,
// then mp4. Whichever the browser supports first wins. The output blob
// carries the actual MIME so the caller can persist the right
// Content-Type + file extension.
//
// Output format:
//   { blob, mime, ext, durationSec, sizeBytes }
//
// Usage:
//   import { compressVideo, isSupported } from "/lib/video-compression.js";
//   if (!isSupported()) { /* fall back to no-compression path */ }
//   const result = await compressVideo(file, {
//     maxDurationSec: 30,
//     targetHeight: 720,
//     videoBitsPerSecond: 600_000,
//     onProgress: (pct) => updateUI(pct),
//   });
// =============================================================================

/**
 * Returns true if the browser can re-encode video via MediaRecorder +
 * canvas.captureStream + HTMLMediaElement.captureStream. Older Safari
 * (<14.1) returns false; the caller should keep the original file in
 * that case.
 */
export function isSupported() {
  if (typeof window === "undefined") return false;
  if (!window.MediaRecorder) return false;
  if (typeof HTMLCanvasElement.prototype.captureStream !== "function") return false;
  if (typeof HTMLMediaElement.prototype.captureStream !== "function") return false;
  // At least one of the candidate codecs must be supported.
  return chooseMimeType() !== null;
}

// Preference order for output container/codec. WebM/VP9 is most efficient;
// VP8 is older-but-widely-supported; MP4/H264 is the Safari preference.
const MIME_CANDIDATES = [
  { mime: "video/webm;codecs=vp9", ext: "webm" },
  { mime: "video/webm;codecs=vp8", ext: "webm" },
  { mime: "video/webm",            ext: "webm" },
  { mime: "video/mp4;codecs=avc1.42E01E", ext: "mp4" },
  { mime: "video/mp4",             ext: "mp4" },
];

function chooseMimeType() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return null;
  for (const c of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(c.mime)) return c;
    } catch { /* keep trying */ }
  }
  return null;
}

/**
 * Compress and trim a video file.
 *
 * @param {File|Blob} file - source video
 * @param {object}   opts
 * @param {number}   opts.maxDurationSec   - hard cap on output length (default 30)
 * @param {number}   opts.targetHeight     - downscale so output height ≤ this (default 720)
 * @param {number}   opts.videoBitsPerSecond - MediaRecorder bitrate (default 600_000)
 * @param {function} opts.onProgress       - called with 0..1 as encoding proceeds
 *
 * @returns {Promise<{blob: Blob, mime: string, ext: string,
 *                    durationSec: number, sizeBytes: number}>}
 */
export async function compressVideo(file, opts = {}) {
  const {
    maxDurationSec     = 30,
    targetHeight       = 720,
    videoBitsPerSecond = 600_000,
    onProgress         = () => {},
  } = opts;

  if (!isSupported()) {
    throw new Error("Video compression not supported in this browser.");
  }
  const codec = chooseMimeType();
  if (!codec) throw new Error("No supported video codec found.");

  // Load the source into a hidden <video> element so we can both
  // decode it (canvas drawing) and capture its native audio track.
  const url = URL.createObjectURL(file);
  const videoEl = document.createElement("video");
  videoEl.src = url;
  videoEl.muted = true;              // don't audibly play during encode
  videoEl.playsInline = true;        // iOS Safari: don't go fullscreen
  videoEl.preload = "auto";

  try {
    // Wait for metadata so we know dimensions and duration.
    await new Promise((resolve, reject) => {
      videoEl.onloadedmetadata = () => resolve();
      videoEl.onerror = () => reject(new Error("Could not decode this video file."));
      // Some browsers fire neither without an explicit load() call.
      try { videoEl.load(); } catch {}
    });

    const sourceW = videoEl.videoWidth;
    const sourceH = videoEl.videoHeight;
    const sourceDuration = Number.isFinite(videoEl.duration) ? videoEl.duration : null;
    if (!sourceW || !sourceH) throw new Error("Source video has no resolution metadata.");

    // Downscale so the SHORTER dimension matches targetHeight. Preserves
    // aspect ratio whether the video is landscape or portrait. If the
    // source is smaller than targetHeight, leave it alone (no upscaling).
    const minSide = Math.min(sourceW, sourceH);
    const scale = minSide > targetHeight ? targetHeight / minSide : 1;
    const outW = Math.round(sourceW * scale);
    const outH = Math.round(sourceH * scale);
    // Some encoders require even dimensions; round to the nearest even.
    const evenW = outW % 2 === 0 ? outW : outW + 1;
    const evenH = outH % 2 === 0 ? outH : outH + 1;

    // Effective output duration = min(source, cap).
    const outDuration = Math.min(sourceDuration ?? maxDurationSec, maxDurationSec);

    // Canvas for downscaled frames.
    const canvas = document.createElement("canvas");
    canvas.width  = evenW;
    canvas.height = evenH;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Could not create 2D canvas context.");

    // Combine canvas video stream + original audio track into a single stream.
    const canvasStream = canvas.captureStream(30); // 30 fps recording target
    let combinedStream = canvasStream;
    try {
      const sourceStream = videoEl.captureStream
        ? videoEl.captureStream()
        : (videoEl.mozCaptureStream ? videoEl.mozCaptureStream() : null);
      if (sourceStream) {
        const audioTracks = sourceStream.getAudioTracks();
        if (audioTracks.length > 0) {
          // Build a new MediaStream so we don't mutate the canvas's stream.
          combinedStream = new MediaStream([
            ...canvasStream.getVideoTracks(),
            ...audioTracks,
          ]);
        }
      }
    } catch (e) {
      // If audio capture fails, fall back to video-only. Verification can
      // still work — handwritten card + visible artwork are the load-bearing
      // signals, audio is bonus.
      console.warn("[video-compression] audio capture failed; encoding video-only:", e);
    }

    // Record.
    const recorder = new MediaRecorder(combinedStream, {
      mimeType: codec.mime,
      videoBitsPerSecond,
    });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

    const finalBlob = new Promise((resolve, reject) => {
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: codec.mime });
        resolve(blob);
      };
      recorder.onerror = (e) => reject(new Error("Recording failed: " + (e?.error?.message || "unknown")));
    });

    recorder.start();
    videoEl.currentTime = 0;
    // Some Safari versions require explicit play() after currentTime reset.
    await videoEl.play();

    // Drawing loop. Uses requestAnimationFrame for visual sync; the recorder
    // samples the canvas via captureStream's internal pacing. We stop both
    // when we hit the duration cap OR the source video ends naturally.
    const startedAt = performance.now();
    let stopped = false;
    function stopAll() {
      if (stopped) return;
      stopped = true;
      try { videoEl.pause(); } catch {}
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {}
      // Release stream tracks so the browser doesn't think we're still recording.
      try {
        for (const t of combinedStream.getTracks()) t.stop();
      } catch {}
    }

    function frame() {
      if (stopped) return;
      const elapsedSec = (performance.now() - startedAt) / 1000;
      const reachedCap = elapsedSec >= outDuration;
      const sourceEnded = videoEl.ended;
      if (reachedCap || sourceEnded) {
        stopAll();
        return;
      }
      try {
        ctx.drawImage(videoEl, 0, 0, evenW, evenH);
      } catch (e) {
        // CORS-tainted or unloaded — try to keep going; the next frame may succeed.
      }
      // Progress: fraction of the target output duration we've covered.
      const pct = Math.min(1, elapsedSec / outDuration);
      try { onProgress(pct); } catch {}
      requestAnimationFrame(frame);
    }
    // Also stop on natural end-of-video (in case ended fires before we tick).
    videoEl.onended = stopAll;
    requestAnimationFrame(frame);

    const blob = await finalBlob;
    // Hard safety stop in case the rAF loop got starved.
    stopAll();

    // Best-effort: read the output's actual duration for the DB row.
    // If the browser can't decode its own output (rare), fall back to the
    // requested cap — close enough for the audit log.
    let actualDuration = outDuration;
    try {
      actualDuration = await readBlobDuration(blob);
    } catch { /* keep cap */ }

    return {
      blob,
      mime: codec.mime,
      ext: codec.ext,
      durationSec: actualDuration,
      sizeBytes: blob.size,
    };
  } finally {
    try { URL.revokeObjectURL(url); } catch {}
  }
}

// Read a blob's duration by loading it into a throwaway <video> element.
// Same trick the existing readVideoDuration helper uses in portal/index.html.
function readBlobDuration(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.src = url;
    v.onloadedmetadata = () => {
      const d = v.duration;
      try { URL.revokeObjectURL(url); } catch {}
      if (Number.isFinite(d)) resolve(d);
      else reject(new Error("duration not finite"));
    };
    v.onerror = () => {
      try { URL.revokeObjectURL(url); } catch {}
      reject(new Error("could not decode blob to read duration"));
    };
  });
}
