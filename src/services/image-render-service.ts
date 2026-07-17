import sharp from "sharp";
import { RepoReaderError } from "../runtime/errors.js";
import { IgnoreEngine, loadRepoMcpIgnorePatterns } from "./ignore-engine.js";
import { PathSandbox } from "./path-sandbox.js";

const MAX_INPUT_PIXELS = 20_000_000;
const MAX_CONCURRENT_RENDERS = 1;
const MAX_WAITING_RENDERS = 8;
const DEFAULT_MAX_LONG_EDGE = 2560;
const MIN_LONG_EDGE = 64;
const MIN_ALPHA_PRESERVING_LONG_EDGE = 320;
export const MAX_IMAGE_BASE64_BYTES = 9 * 1024 * 1024;
export const MAX_IMAGE_RESULT_BYTES = 12 * 1024 * 1024;

type ImageFormat = "auto" | "jpeg" | "png" | "webp";
type RenderConfig = { maxBase64Bytes?: number };

export type ImageRenderOptions = {
  path: string;
  max_long_edge?: number;
  format?: ImageFormat;
};

export type ImageRenderResult = {
  bytes: Buffer;
  mimeType: string;
  source_width: number;
  source_height: number;
  rendered_width: number;
  rendered_height: number;
  source_mime_type: string;
  output_mime_type: string;
  output_bytes: number;
  scale: number;
  transparency_mode: "preserved" | "flattened";
  warnings: string[];
};

let activeRenders = 0;
const waitingRenders: Array<() => void> = [];

export class ImageRenderService {
  private readonly maxBase64Bytes: number;

  constructor(private readonly sandbox: PathSandbox, private readonly root: string, config: RenderConfig = {}) {
    this.maxBase64Bytes = config.maxBase64Bytes ?? MAX_IMAGE_BASE64_BYTES;
  }

  async render(options: ImageRenderOptions): Promise<ImageRenderResult> {
    return withRenderSlot(() => this.renderWithinSlot(options));
  }

  private async renderWithinSlot(options: ImageRenderOptions): Promise<ImageRenderResult> {
    const resolved = await this.resolveAllowedImage(options.path);
    try {
      const [metadata, stats] = await Promise.all([
        sharp(resolved.absolutePath, { limitInputPixels: MAX_INPUT_PIXELS }).metadata(),
        sharp(resolved.absolutePath, { limitInputPixels: MAX_INPUT_PIXELS }).stats()
      ]);
      if (!metadata.width || !metadata.height || !metadata.format || !isSupportedFormat(metadata.format)) {
        throw new RepoReaderError("IMAGE_UNSUPPORTED", "Only static JPEG, PNG, and WebP images are supported.");
      }
      if ((metadata.pages ?? 1) > 1) {
        throw new RepoReaderError("IMAGE_ANIMATION_UNSUPPORTED", "Animated or multi-page images are not supported.");
      }

      const source = orientedDimensions(metadata.width, metadata.height, metadata.orientation);
      const format = options.format ?? "auto";
      const targetLongEdge = Math.min(options.max_long_edge ?? DEFAULT_MAX_LONG_EDGE, Math.max(source.width, source.height));
      const needsAlpha = !stats.isOpaque;
      const preserved = needsAlpha && format !== "jpeg";
      const candidate = preserved || !needsAlpha
        ? await this.findCandidate(resolved.absolutePath, source, targetLongEdge, format, preserved, false)
        : undefined;
      const rendered = candidate ?? (needsAlpha && (format === "auto" || format === "jpeg")
        ? await this.findCandidate(resolved.absolutePath, source, targetLongEdge, format, false, true)
        : undefined);

      if (!rendered) {
        throw new RepoReaderError("IMAGE_RESULT_TOO_LARGE", "The image cannot fit the response budget after proportional downscaling.", {
          diagnostics: {
            source_width: source.width,
            source_height: source.height,
            recommended_max_long_edge: Math.min(1024, targetLongEdge)
          }
        });
      }
      const transparencyMode = rendered.flattened ? "flattened" : "preserved";
      const warnings = rendered.flattened ? ["Transparency was flattened onto a gray-and-white checkerboard preview to fit the response budget."] : [];
      return {
        bytes: rendered.bytes,
        mimeType: rendered.mimeType,
        source_width: source.width,
        source_height: source.height,
        rendered_width: rendered.width,
        rendered_height: rendered.height,
        source_mime_type: `image/${metadata.format === "jpeg" ? "jpeg" : metadata.format}`,
        output_mime_type: rendered.mimeType,
        output_bytes: rendered.bytes.byteLength,
        scale: Math.min(rendered.width / source.width, rendered.height / source.height),
        transparency_mode: transparencyMode,
        warnings
      };
    } catch (error) {
      if (error instanceof RepoReaderError) throw error;
      throw new RepoReaderError("IMAGE_DECODE_FAILED", "The image could not be decoded safely.");
    }
  }

  private async resolveAllowedImage(path: string) {
    const resolved = await this.sandbox.resolve(path);
    const ignoreEngine = new IgnoreEngine(await loadRepoMcpIgnorePatterns(this.root));
    if (!resolved.stat.isFile()) throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", "The image path is not a regular file.");
    if (ignoreEngine.isIgnored(resolved.repoPath)) throw new RepoReaderError("DEFAULT_EXCLUDE_BLOCKED", "The image path is excluded by policy.");
    if (ignoreEngine.isSensitiveCandidate(resolved.repoPath)) throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", "The image path is secret-sensitive.");
    return resolved;
  }

  private async findCandidate(
    path: string,
    source: { width: number; height: number },
    targetLongEdge: number,
    format: ImageFormat,
    preserveAlpha: boolean,
    flattened: boolean
  ) {
    for (const longEdge of imageLongEdges(targetLongEdge, preserveAlpha ? MIN_ALPHA_PRESERVING_LONG_EDGE : MIN_LONG_EDGE)) {
      const scale = longEdge / Math.max(source.width, source.height);
      const width = Math.max(1, Math.round(source.width * scale));
      const height = Math.max(1, Math.round(source.height * scale));
      for (const quality of preserveAlpha ? [90, 80, 70] : [90, 78, 66]) {
        const pipeline = sharp(path, { limitInputPixels: MAX_INPUT_PIXELS })
          .rotate()
          .resize({ width, height, fit: "inside", withoutEnlargement: true, kernel: sharp.kernel.lanczos3 });
        const useWebp = format === "webp" || preserveAlpha && format === "auto";
        const bytes = flattened
          ? await sharp(checkerboard(width, height))
            .composite([{ input: await pipeline.png().toBuffer() }])
            .jpeg({ quality, chromaSubsampling: "4:4:4" })
            .toBuffer()
          : await (useWebp
            ? pipeline.webp({ nearLossless: true, quality, alphaQuality: 100, effort: 6 })
            : format === "png"
              ? pipeline.png({ compressionLevel: 9, adaptiveFiltering: true })
              : pipeline.jpeg({ quality, chromaSubsampling: "4:4:4" }))
            .toBuffer();
        if (base64Bytes(bytes.byteLength) <= this.maxBase64Bytes) {
          return { bytes, width, height, flattened, mimeType: flattened ? "image/jpeg" : useWebp ? "image/webp" : format === "png" ? "image/png" : "image/jpeg" };
        }
      }
    }
    return undefined;
  }
}

function isSupportedFormat(format: string): format is "jpeg" | "png" | "webp" {
  return format === "jpeg" || format === "png" || format === "webp";
}

function orientedDimensions(width: number, height: number, orientation?: number) {
  return orientation && [5, 6, 7, 8].includes(orientation) ? { width: height, height: width } : { width, height };
}

function imageLongEdges(target: number, minimumUsefulEdge: number): number[] {
  const minimum = Math.min(minimumUsefulEdge, target);
  return [...new Set([target, Math.floor(target * 0.7), Math.floor(target * 0.45), minimum].map((edge) => Math.max(minimum, edge)))];
}

function base64Bytes(rawBytes: number): number {
  return 4 * Math.ceil(rawBytes / 3);
}

function checkerboard(width: number, height: number): Buffer {
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><pattern id="c" width="24" height="24" patternUnits="userSpaceOnUse"><rect width="24" height="24" fill="#f4f4f4"/><path d="M0 0h12v12H0zM12 12h12v12H12z" fill="#c8c8c8"/></pattern></defs><rect width="100%" height="100%" fill="url(#c)"/></svg>`);
}

async function withRenderSlot<T>(work: () => Promise<T>): Promise<T> {
  let reserved = false;
  if (activeRenders >= MAX_CONCURRENT_RENDERS) {
    if (waitingRenders.length >= MAX_WAITING_RENDERS) {
      throw new RepoReaderError("IMAGE_RENDER_BUSY", "Image rendering is busy. Try again shortly.", { retryable: true });
    }
    await new Promise<void>((resolve) => waitingRenders.push(resolve));
    reserved = true;
  }
  if (!reserved) {
    activeRenders += 1;
  }
  try {
    return await work();
  } finally {
    const next = waitingRenders.shift();
    if (next) {
      next();
    } else {
      activeRenders -= 1;
    }
  }
}
