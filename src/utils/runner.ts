import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { ffmpegBin, ffprobeBin } from "./config";

const FFMPEG_BIN = ffmpegBin;
const FFPROBE_BIN = ffprobeBin;

function execFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG_BIN, args, { maxBuffer: 10 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() || error.message;
        return reject(new Error(`ffmpeg failed: ${detail}`));
      }
      resolve();
    });
  });
}

function probeHasAudio(inputPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      FFPROBE_BIN,
      ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", inputPath],
      { maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(false);
        resolve(stdout.trim().length > 0);
      }
    );
  });
}

export async function runFfmpegHLS(inputPath: string, outputDir: string): Promise<string> {
  const hasAudio = await probeHasAudio(inputPath);
  const args = [
    '-i', inputPath,
    '-filter_complex',
    '[0:v]split=3[v1][v2][v3];' +
    '[v1]scale=w=1920:h=1080[v1out];' +
    '[v2]scale=w=1280:h=720[v2out];' +
    '[v3]scale=w=854:h=480[v3out]',
    '-map', '[v1out]', '-c:v:0', 'h264', '-b:v:0', '5000k',
    '-map', '[v2out]', '-c:v:1', 'h264', '-b:v:1', '2800k',
    '-map', '[v3out]', '-c:v:2', 'h264', '-b:v:2', '1400k',
  ];

  if (hasAudio) {
    args.push('-map', 'a:0', '-map', 'a:0', '-map', 'a:0', '-c:a', 'aac', '-b:a', '128k');
  }

  const posixOutputDir = outputDir.replace(/\\/g, "/");
  args.push(
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_playlist_type', 'vod',
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', hasAudio ? 'v:0,a:0 v:1,a:1 v:2,a:2' : 'v:0 v:1 v:2',
    '-hls_segment_filename', `${posixOutputDir}/stream_%v/data%03d.ts`,
    `${posixOutputDir}/stream_%v/playlist.m3u8`
  );

  await execFfmpeg(args);
  return outputDir;
}

export function probeDuration(inputPath: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      FFPROBE_BIN,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputPath],
      { maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(0);
        const duration = parseFloat(stdout.trim());
        resolve(Number.isFinite(duration) && duration > 0 ? duration : 0);
      }
    );
  });
}

const clampOffset = (offset: number, durationSec: number): number =>
  durationSec > 0
    ? Math.min(Math.max(offset, 0.5), Math.max(0.5, durationSec - 0.5))
    : offset;

export async function runFfmpegThumbnails(
  inputPath: string,
  outputDir: string,
  durationSec: number
): Promise<string> {
  fs.mkdirSync(outputDir, { recursive: true });

  const offsets = [clampOffset(4, durationSec)];
  if (durationSec > 0) {
    offsets.push(
      clampOffset(durationSec * 0.25, durationSec),
      clampOffset(durationSec * 0.5, durationSec),
      clampOffset(durationSec * 0.75, durationSec)
    );
  }

  for (let i = 0; i < offsets.length; i++) {
    const name = i === 0 ? "poster" : `thumb-${i}`;
    await execFfmpeg([
      "-ss", String(offsets[i]),
      "-i", inputPath,
      "-frames:v", "1",
      "-vf", "scale=640:-2",
      "-q:v", "4",
      "-y",
      path.join(outputDir, `${name}.jpg`),
    ]);
    await execFfmpeg([
      "-ss", String(offsets[i]),
      "-i", inputPath,
      "-frames:v", "1",
      "-vf", "scale=640:-2",
      "-y",
      path.join(outputDir, `${name}.webp`),
    ]);
  }

  return outputDir;
}