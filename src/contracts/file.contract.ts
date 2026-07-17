import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";

export const PathInputSchema = z.object({
  path: z.string().min(1)
});

export const GlobScopeSchema = z.object({
  include_globs: z.array(z.string()).optional(),
  exclude_globs: z.array(z.string()).optional()
});

export const FetchFileInputSchema = RepoInputSchema.extend({
  path: z.string().min(1),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
  max_bytes: z.number().int().positive().optional(),
  override_default_excludes: z.boolean().optional()
});

export const RepoGetImageInputSchema = RepoInputSchema.extend({
  path: z.string().min(1).describe("Repository-relative path to a static JPEG, PNG, or WebP image."),
  max_long_edge: z.number().int().min(64).max(2560).optional().describe("Optional maximum rendered long edge in pixels; defaults to 2560 and never enlarges images."),
  format: z.enum(["auto", "jpeg", "png", "webp"]).optional().describe("Optional forced output conversion. JPEG is compact for opaque images, PNG provides lossless encoding with alpha, and WebP uses near-lossless compression; auto selects JPEG or WebP from decoded opacity.")
});

export const ImageRenderResultSchema = z.object({
  source_width: z.number().int().positive().describe("Original decoded image width in pixels."),
  source_height: z.number().int().positive().describe("Original decoded image height in pixels."),
  rendered_width: z.number().int().positive().describe("Delivered image width after proportional downscaling."),
  rendered_height: z.number().int().positive().describe("Delivered image height after proportional downscaling."),
  source_mime_type: z.string().describe("Detected source image MIME type."),
  output_mime_type: z.string().describe("MIME type of the delivered image."),
  output_bytes: z.number().int().nonnegative().describe("Encoded image bytes before Base64 transport encoding."),
  scale: z.number().positive().max(1).describe("Uniform rendered-to-source scale; never exceeds one."),
  transparency_mode: z.enum(["preserved", "flattened"]).describe("Whether meaningful source transparency was retained or visibly flattened."),
  warnings: z.array(z.string()).describe("Safe rendering warnings, including an explicit flattening notice when relevant.")
});

export const ReadManyInputSchema = RepoInputSchema.extend({
  paths: z.array(z.string()).optional(),
  include_globs: z.array(z.string()).optional(),
  exclude_globs: z.array(z.string()).optional(),
  max_files: z.number().int().positive().optional(),
  max_bytes_per_file: z.number().int().positive().optional(),
  max_total_bytes: z.number().int().positive().optional(),
  cursor: z.string().optional()
}).refine((input) => (input.paths?.length ?? 0) > 0 || (input.include_globs?.length ?? 0) > 0, {
  message: "repo_read_many requires paths or include_globs.",
  path: ["paths"]
});

export const FileClassificationSchema = z.object({
  path: z.string(),
  language: z.string().optional(),
  is_binary: z.boolean(),
  is_secret_candidate: z.boolean(),
  is_generated: z.boolean()
});

export const FileSummarySchema = z.object({
  path: z.string(),
  type: z.enum(["file", "directory", "nested_repo", "submodule"]),
  size_bytes: z.number().int().nonnegative().optional()
});

export const FileContentSchema = z.object({
  path: z.string(),
  language: z.string().optional(),
  size_bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  total_lines: z.number().int().nonnegative(),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  truncated: z.boolean(),
  text: z.string(),
  warnings: z.array(z.string()).default([])
});

export const ReadManyResultSchema = z.object({
  files: z.array(FileContentSchema),
  skipped: z.array(z.object({
    path: z.string(),
    reason: z.string()
  })),
  matched_count: z.number().int().nonnegative(),
  returned_count: z.number().int().nonnegative(),
  truncated: z.boolean(),
  next_cursor: z.string().optional()
});
