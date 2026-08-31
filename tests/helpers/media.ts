/**
 * media.ts — provide VALID image + video inputs to a migration render.
 *
 * The WAN2.2 video-edit workflow has real input-media nodes (LoadImage +
 * VHS_LoadVideo). Without decodable input files the Step-12 render errors on the
 * loaders, so a migration test that just "produces a file" can silently pass on a
 * broken graph. This generates valid, non-trivial inputs with ffmpeg (no binary
 * fixtures to commit), uploads them into the GPU node's ComfyUI input dir, and
 * rewrites the API prompt's loader nodes to reference them — so the render runs
 * on inputs we control and can reason about.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";

const exec = promisify(execFile);

export interface TestMedia {
  imagePath: string; // local path to a valid PNG
  videoPath: string; // local path to a valid H.264 MP4
  dir: string;
}

/**
 * Generate a valid test image (color-pattern PNG) and video (H.264 MP4 with
 * motion) via ffmpeg. `frames` should be >= the workflow's frame_load_cap so the
 * video loader has enough frames. Deterministic content (testsrc) — decodable,
 * non-blank, and with temporal variation so it exercises a real edit.
 */
export async function generateTestMedia(opts: { frames?: number; size?: string; fps?: number } = {}): Promise<TestMedia> {
  const frames = opts.frames ?? 48;
  const size = opts.size ?? "512x512";
  const fps = opts.fps ?? 24;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pw-input-media-"));
  const imagePath = path.join(dir, "test-input.png");
  const videoPath = path.join(dir, "test-input.mp4");

  // Image: a testsrc pattern frame (color bars + moving marker + text) — a valid,
  // clearly non-blank RGB image the LoadImage node can decode.
  await exec("ffmpeg", ["-y", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=1`, "-frames:v", "1", imagePath]);

  // Video: H.264 yuv420p (broad decoder support), `frames` frames of testsrc
  // (has a sweeping element → real inter-frame motion).
  const duration = (frames / fps).toFixed(3);
  await exec("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=${fps}:duration=${duration}`,
    "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", videoPath,
  ]);

  return { imagePath, videoPath, dir };
}

/**
 * Upload a file into a ComfyUI server's input dir via POST /upload/image (the
 * standard endpoint — accepts images and, in the VHS ecosystem, videos too).
 * Returns the stored { name, subfolder } ComfyUI will reference.
 */
export async function uploadComfyInput(
  comfyUrl: string,
  filePath: string,
  contentType: string
): Promise<{ name: string; subfolder: string }> {
  const base = comfyUrl.replace(/\/+$/, "");
  const buf = await fsp.readFile(filePath);
  const name = path.basename(filePath);
  const form = new FormData();
  form.append("image", new Blob([buf], { type: contentType }), name);
  form.append("type", "input");
  form.append("overwrite", "true");
  const res = await fetch(`${base}/upload/image`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`upload ${name} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { name?: string; subfolder?: string };
  return { name: body.name ?? name, subfolder: body.subfolder ?? "" };
}

/** Combine subfolder + name the way ComfyUI loaders expect ("sub/name" or "name"). */
function joinRef(u: { name: string; subfolder: string }): string {
  return u.subfolder ? `${u.subfolder}/${u.name}` : u.name;
}

export interface WiredInputs {
  image?: string;
  video?: string;
  imageNodes: string[];
  videoNodes: string[];
}

/**
 * Rewrite an API-format prompt's input-media loaders to reference the uploaded
 * files. LoadImage.inputs.image and VHS_LoadVideo.inputs.video are set to the
 * uploaded refs. Returns which nodes were wired (empty arrays if the graph has
 * none — a caller can then skip staging). Pure aside from the passed refs.
 */
export function wireInputMedia(
  prompt: Record<string, any>,
  refs: { image?: { name: string; subfolder: string }; video?: { name: string; subfolder: string } }
): WiredInputs {
  const wired: WiredInputs = { imageNodes: [], videoNodes: [] };
  for (const [id, node] of Object.entries(prompt)) {
    const ct = (node as any)?.class_type;
    const inputs = (node as any)?.inputs;
    if (!ct || !inputs) continue;
    if (ct === "LoadImage" && refs.image) {
      inputs.image = joinRef(refs.image);
      wired.imageNodes.push(id);
      wired.image = inputs.image;
    } else if (/VHS_LoadVideo|LoadVideo/.test(ct) && refs.video) {
      // VHS_LoadVideo uses `video`; be tolerant of the path/upload variants.
      inputs.video = joinRef(refs.video);
      wired.videoNodes.push(id);
      wired.video = inputs.video;
    }
  }
  return wired;
}

/** End-to-end: generate media, upload to ComfyUI, rewire the prompt. Returns the wiring. */
export async function stageValidInputs(
  comfyUrl: string,
  prompt: Record<string, any>,
  opts: { frames?: number; size?: string } = {}
): Promise<{ wired: WiredInputs; media: TestMedia }> {
  const media = await generateTestMedia(opts);
  const image = await uploadComfyInput(comfyUrl, media.imagePath, "image/png");
  const video = await uploadComfyInput(comfyUrl, media.videoPath, "video/mp4");
  const wired = wireInputMedia(prompt, { image, video });
  return { wired, media };
}
