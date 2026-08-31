/**
 * Standalone, fast (@quality) checks for the render-quality assessment primitives
 * — no GPU / backend / ComfyUI needed, just ffmpeg. Proves the helpers actually
 * discriminate a valid render from a blank/black one, so the @migration suite's
 * quality gate is trustworthy.
 */
import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateTestMedia, wireInputMedia } from "./helpers/media";
import { probeMedia, blackRatio, spatialContrast, DEFAULT_THRESHOLDS } from "./helpers/quality";

const exec = promisify(execFile);

test.describe("render output quality assessment @quality", () => {
  test("a valid generated video passes probe + non-black + has motion", async () => {
    const { videoPath, imagePath, dir } = await generateTestMedia({ frames: 48, size: "512x512" });
    try {
      const probe = await probeMedia(videoPath);
      expect(probe, "ffprobe must find a video stream").toBeTruthy();
      expect(probe!.kind).toBe("video");
      expect(probe!.width).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.minWidth);
      expect(probe!.height).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.minHeight);
      expect(probe!.nbFrames).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.minFrames);
      expect(probe!.sizeBytes).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.minSizeBytes);

      const black = await blackRatio(videoPath, probe!.durationSec);
      expect(black, "a real render is not mostly black").toBeLessThan(DEFAULT_THRESHOLDS.maxBlackRatio);

      const contrast = await spatialContrast(videoPath);
      expect(contrast, "testsrc has rich spatial content → high luma contrast").toBeGreaterThan(3);

      const imgProbe = await probeMedia(imagePath);
      expect(imgProbe?.width).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.minWidth);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test("wireInputMedia rewrites LoadImage + VHS_LoadVideo to the staged refs", () => {
    const prompt: Record<string, any> = {
      "31": { class_type: "LoadImage", inputs: { image: "old.png", upload: "image" } },
      "90": { class_type: "VHS_LoadVideo", inputs: { video: "old.mp4", frame_load_cap: 30 } },
      "5": { class_type: "UNETLoader", inputs: { unet_name: "x.safetensors" } },
    };
    const wired = wireInputMedia(prompt, {
      image: { name: "test-input.png", subfolder: "" },
      video: { name: "test-input.mp4", subfolder: "" },
    });
    expect(prompt["31"].inputs.image).toBe("test-input.png");
    expect(prompt["90"].inputs.video).toBe("test-input.mp4");
    expect(prompt["5"].inputs.unet_name).toBe("x.safetensors"); // untouched
    expect(wired.imageNodes).toEqual(["31"]);
    expect(wired.videoNodes).toEqual(["90"]);
  });

  test("an all-black video is caught (blackRatio ~ 1, flat luma)", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pw-black-"));
    const black = path.join(dir, "black.mp4");
    try {
      await exec("ffmpeg", [
        "-y", "-f", "lavfi", "-i", "color=c=black:s=512x512:r=24:d=2",
        "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", black,
      ]);
      const probe = await probeMedia(black);
      expect(probe).toBeTruthy();
      const ratio = await blackRatio(black, probe!.durationSec);
      expect(ratio, "all-black clip must be flagged").toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.maxBlackRatio);
      const contrast = await spatialContrast(black);
      expect(contrast, "flat black has ~0 spatial contrast").toBeLessThan(3);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
