/**
 * quality.ts — judge the QUALITY of a migration render's output, not just its
 * existence. Downloads each output from ComfyUI (/view) and inspects it with
 * ffprobe/ffmpeg: valid stream, real dimensions, enough frames, non-trivial
 * size, and — the check that catches a "ran but produced garbage" render — that
 * the frames are not all-black / not a single flat color.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { vlmJudgeOutput, type VlmNodeConfig, type VlmVerdict } from "./vlmJudge";

const exec = promisify(execFile);

export interface MediaProbe {
  kind: "video" | "image" | "unknown";
  codec?: string;
  width: number;
  height: number;
  nbFrames: number;
  durationSec: number;
  sizeBytes: number;
}

export interface QualityThresholds {
  minWidth: number;
  minHeight: number;
  minFrames: number; // videos only
  minSizeBytes: number;
  minDurationSec: number; // videos only
  maxBlackRatio: number; // fail if >= this fraction of a video is black
}

export const DEFAULT_THRESHOLDS: QualityThresholds = {
  minWidth: 64,
  minHeight: 64,
  minFrames: 8,
  minSizeBytes: 8 * 1024,
  minDurationSec: 0.2,
  maxBlackRatio: 0.95,
};

export interface QualityVerdict {
  ok: boolean;
  filename: string;
  type: string;
  probe: MediaProbe | null;
  blackRatio: number | null;
  spatialContrast: number | null; // avg per-frame luma range YHIGH-YLOW (0 = flat/blank color)
  vlm: VlmVerdict | null; // subjective judge (only when a VlmNodeConfig is supplied)
  failures: string[];
}

/**
 * Optional subjective judge: run the on-node local VLM over the output and fail
 * on a FAIL verdict. Catches "ran-but-degenerate" renders (a muddy near-flat
 * image) that clear the objective spatialContrast threshold and would otherwise
 * FALSELY PASS — see vlmJudge.ts. `vlm` comes from the localized workflow
 * (extractVlmConfigFromGraph). If the judge can't run (no VLM / infra error) it
 * returns null and assessOutput keeps only the objective verdict (fail-open on
 * infra, fail-closed on an actual FAIL).
 */
export interface JudgeOptions {
  vlm: VlmNodeConfig;
  prompt?: string;
  comfyUrl?: string;
}

/** Download an output file from ComfyUI's /view into a local path. */
export async function fetchOutput(
  comfyUrl: string,
  out: { filename: string; type: string; subfolder?: string },
  destDir: string
): Promise<string> {
  const base = comfyUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({ filename: out.filename, subfolder: out.subfolder ?? "", type: "output" });
  const res = await fetch(`${base}/view?${params.toString()}`);
  if (!res.ok) throw new Error(`GET /view ${out.filename} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dest = path.join(destDir, out.filename.replace(/[^\w.-]/g, "_"));
  await fsp.writeFile(dest, buf);
  return dest;
}

/** ffprobe → structured metrics. Never throws; returns null on probe failure. */
export async function probeMedia(filePath: string): Promise<MediaProbe | null> {
  try {
    const { stdout } = await exec("ffprobe", [
      "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath,
    ]);
    const j = JSON.parse(stdout);
    const v = (j.streams ?? []).find((s: any) => s.codec_type === "video");
    if (!v) return null;
    const size = Number(j.format?.size ?? (await fsp.stat(filePath)).size);
    const nbFrames = Number(v.nb_frames ?? v.nb_read_frames ?? 0) || 0;
    const dur = Number(v.duration ?? j.format?.duration ?? 0) || 0;
    const isImage = ["png", "mjpeg", "bmp", "gif"].includes(String(v.codec_name)) && (dur === 0 || nbFrames <= 1);
    return {
      kind: isImage ? "image" : "video",
      codec: v.codec_name,
      width: Number(v.width ?? 0),
      height: Number(v.height ?? 0),
      nbFrames,
      durationSec: dur,
      sizeBytes: size,
    };
  } catch {
    return null;
  }
}

/**
 * Fraction of a video's duration detected as black (ffmpeg blackdetect). ~1.0 =
 * all black (a common "ran but produced nothing visible" failure). 0 for images.
 */
export async function blackRatio(filePath: string, durationSec: number): Promise<number> {
  if (durationSec <= 0) return 0;
  try {
    const { stderr } = await exec("ffmpeg", [
      "-i", filePath, "-vf", "blackdetect=d=0.05:pic_th=0.98", "-an", "-f", "null", "-",
    ]).catch((e: any) => ({ stderr: String(e?.stderr ?? "") }));
    let black = 0;
    for (const m of String(stderr).matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)) {
      black += Number(m[2]) - Number(m[1]);
    }
    return Math.min(1, black / durationSec);
  } catch {
    return 0;
  }
}

/**
 * Average per-frame SPATIAL luma range (YHIGH-YLOW) across sampled frames. ~0 =>
 * every frame is a single flat color (blank output); large => real image content.
 * Uses ffmpeg signalstats; robust to a valid-but-static video (unlike temporal
 * mean-luma spread, which is ~0 for a spatially-rich but motionless clip).
 */
export async function spatialContrast(filePath: string): Promise<number> {
  try {
    const { stderr } = await exec("ffmpeg", [
      "-i", filePath, "-vf", "signalstats,metadata=print", "-frames:v", "12", "-f", "null", "-",
    ]).catch((e: any) => ({ stderr: String(e?.stderr ?? "") }));
    const lows = [...String(stderr).matchAll(/lavfi\.signalstats\.YLOW=([\d.]+)/g)].map((m) => Number(m[1]));
    const highs = [...String(stderr).matchAll(/lavfi\.signalstats\.YHIGH=([\d.]+)/g)].map((m) => Number(m[1]));
    const n = Math.min(lows.length, highs.length);
    if (n === 0) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.max(0, highs[i] - lows[i]);
    return sum / n;
  } catch {
    return 0;
  }
}

/** Assess one output's technical quality against thresholds. */
export async function assessOutput(
  comfyUrl: string,
  out: { filename: string; type: string; subfolder?: string },
  thresholds: QualityThresholds = DEFAULT_THRESHOLDS,
  judge?: JudgeOptions
): Promise<QualityVerdict> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pw-output-quality-"));
  const failures: string[] = [];
  let probe: MediaProbe | null = null;
  let black: number | null = null;
  let contrast: number | null = null;
  let vlm: VlmVerdict | null = null;
  try {
    const local = await fetchOutput(comfyUrl, out, dir);
    probe = await probeMedia(local);
    if (!probe) {
      failures.push("ffprobe found no decodable video stream (corrupt/empty output)");
    } else {
      if (probe.sizeBytes < thresholds.minSizeBytes) failures.push(`size ${probe.sizeBytes}B < ${thresholds.minSizeBytes}B`);
      if (probe.width < thresholds.minWidth || probe.height < thresholds.minHeight)
        failures.push(`dims ${probe.width}x${probe.height} below ${thresholds.minWidth}x${thresholds.minHeight}`);
      if (probe.kind === "video") {
        if (probe.nbFrames > 0 && probe.nbFrames < thresholds.minFrames)
          failures.push(`frames ${probe.nbFrames} < ${thresholds.minFrames}`);
        if (probe.durationSec > 0 && probe.durationSec < thresholds.minDurationSec)
          failures.push(`duration ${probe.durationSec}s < ${thresholds.minDurationSec}s`);
        black = await blackRatio(local, probe.durationSec);
        if (black >= thresholds.maxBlackRatio) failures.push(`black ${(black * 100).toFixed(0)}% >= ${thresholds.maxBlackRatio * 100}%`);
      }
      contrast = await spatialContrast(local);
      if (contrast !== null && contrast < 3)
        failures.push(`flat/blank output: spatial luma contrast ${contrast.toFixed(1)} ~ 0 (single flat color)`);
    }
    // Subjective judge (semantic; catches degenerate renders the objective
    // metric misses). Only fails on an explicit FAIL — a null verdict (no VLM
    // available / infra error) never blocks, so the objective gate still governs.
    if (judge?.vlm && probe) {
      vlm = await vlmJudgeOutput(judge.comfyUrl ?? comfyUrl, out, judge.vlm, { prompt: judge.prompt });
      if (vlm && !vlm.pass) failures.push(`VLM judge FAIL: ${vlm.reason}`);
    }
  } catch (e) {
    failures.push(`assess threw: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
  return { ok: failures.length === 0, filename: out.filename, type: out.type, probe, blackRatio: black, spatialContrast: contrast, vlm, failures };
}
