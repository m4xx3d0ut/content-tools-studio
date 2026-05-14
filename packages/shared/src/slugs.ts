import { z } from "zod";
import { VideoSchema } from "./project.js";

export const SlugAssetSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  filename: z.string().min(1),
  path: z.string().min(1),
  source: z.enum(["seed", "upload"]).default("upload"),
  video: VideoSchema,
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const SlugLibraryManifestSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  assets: z.array(SlugAssetSchema).default([]),
});

export const SlugListResponseSchema = z.object({
  slugs: z.array(
    SlugAssetSchema.extend({
      usageCount: z.number().int().nonnegative().default(0),
    })
  ),
});

export type SlugAsset = z.infer<typeof SlugAssetSchema>;
export type SlugLibraryManifest = z.infer<typeof SlugLibraryManifestSchema>;
export type SlugListResponse = z.infer<typeof SlugListResponseSchema>;
