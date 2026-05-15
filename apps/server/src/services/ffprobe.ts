import { spawn } from "node:child_process";
import type { VideoInfo } from "@content-tools/shared";
import { FFPROBE_PATH } from "../config.js";

type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
};

type FfprobeFormat = {
  duration?: string;
};

type FfprobeResult = {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
};

function parseFraction(value?: string): { num: number; den: number } | null {
  if (!value) return null;
  const parts = value.split("/");
  if (parts.length === 1) {
    const num = Number(parts[0]);
    if (Number.isFinite(num) && num > 0) {
      return { num, den: 1 };
    }
    return null;
  }
  const num = Number(parts[0]);
  const den = Number(parts[1]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return null;
  }
  return { num, den };
}

function parseDurationMs(value?: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.round(seconds * 1000);
}

export async function probeVideo(filePath: string): Promise<VideoInfo> {
  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    filePath,
  ];

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(FFPROBE_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      error += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(error || `ffprobe exited with code ${code}`));
        return;
      }
      resolve(output);
    });
  });

  const parsed = JSON.parse(stdout) as FfprobeResult;
  const videoStream = parsed.streams?.find((stream) => stream.codec_type === "video");
  if (!videoStream) {
    throw new Error("ffprobe did not return a video stream");
  }

  const fpsValue =
    parseFraction(videoStream.avg_frame_rate) ||
    parseFraction(videoStream.r_frame_rate) ||
    { num: 30, den: 1 };

  const durationMs =
    parseDurationMs(parsed.format?.duration) ||
    parseDurationMs(videoStream.duration);

  const audioStream = parsed.streams?.find((stream) => stream.codec_type === "audio");

  return {
    width: videoStream.width ?? 1920,
    height: videoStream.height ?? 1080,
    fpsNum: fpsValue.num,
    fpsDen: fpsValue.den,
    durationMs,
    audio: {
      hasAudio: Boolean(audioStream),
      sampleRate: audioStream?.sample_rate
        ? Number(audioStream.sample_rate)
        : undefined,
      channels: audioStream?.channels,
    },
  };
}

export type AudioInfo = {
  durationMs: number;
  sampleRate?: number;
  channels?: number;
  codecName?: string;
};

export async function probeAudio(filePath: string): Promise<AudioInfo> {
  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    filePath,
  ];

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(FFPROBE_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      error += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(error || `ffprobe exited with code ${code}`));
        return;
      }
      resolve(output);
    });
  });

  const parsed = JSON.parse(stdout) as FfprobeResult;
  const audioStream = parsed.streams?.find((stream) => stream.codec_type === "audio");
  if (!audioStream) {
    throw new Error("ffprobe did not return an audio stream");
  }

  return {
    durationMs:
      parseDurationMs(parsed.format?.duration) ||
      parseDurationMs(audioStream.duration),
    sampleRate: audioStream.sample_rate ? Number(audioStream.sample_rate) : undefined,
    channels: audioStream.channels,
    codecName: audioStream.codec_name,
  };
}
