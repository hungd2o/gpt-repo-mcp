import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { ImageRenderService, MAX_IMAGE_BASE64_BYTES } from "../src/services/image-render-service.js";
import { RepoReaderError } from "../src/runtime/errors.js";
import { PathSandbox } from "../src/services/path-sandbox.js";

describe("ImageRenderService", () => {
  test("downscales opaque 4K input proportionally and never enlarges", async () => {
    const root = await createRoot();
    await sharp({ create: { width: 3840, height: 2160, channels: 3, background: "#63748b" } }).jpeg().toFile(join(root, "wide.jpg"));
    await sharp({ create: { width: 40, height: 20, channels: 3, background: "#63748b" } }).png().toFile(join(root, "small.png"));
    const service = new ImageRenderService(new PathSandbox(root), root);

    const wide = await service.render({ path: "wide.jpg" });
    const small = await service.render({ path: "small.png" });

    expect(wide.output_mime_type).toBe("image/jpeg");
    expect([wide.rendered_width, wide.rendered_height]).toEqual([2560, 1440]);
    expect(wide.scale).toBeCloseTo(2 / 3);
    expect(small.rendered_width).toBe(40);
    expect(small.rendered_height).toBe(20);
    expect(small.scale).toBe(1);
  });

  test("uses actual pixel opacity to preserve meaningful alpha as WebP", async () => {
    const root = await createRoot();
    await sharp({ create: { width: 128, height: 80, channels: 4, background: { r: 220, g: 30, b: 40, alpha: 0.5 } } }).png().toFile(join(root, "transparent.png"));
    await sharp({ create: { width: 128, height: 80, channels: 4, background: { r: 220, g: 30, b: 40, alpha: 1 } } }).png().toFile(join(root, "opaque-alpha.png"));
    const service = new ImageRenderService(new PathSandbox(root), root);

    const transparent = await service.render({ path: "transparent.png" });
    const opaqueAlpha = await service.render({ path: "opaque-alpha.png" });

    expect(transparent.output_mime_type).toBe("image/webp");
    expect(transparent.transparency_mode).toBe("preserved");
    expect((await sharp(transparent.bytes).stats()).isOpaque).toBe(false);
    expect(opaqueAlpha.output_mime_type).toBe("image/jpeg");
  });

  test("honors forced PNG and near-lossless WebP output formats", async () => {
    const root = await createRoot();
    await sharp({ create: { width: 128, height: 80, channels: 4, background: { r: 30, g: 90, b: 220, alpha: 0.5 } } }).png().toFile(join(root, "transparent.png"));
    const service = new ImageRenderService(new PathSandbox(root), root);

    const png = await service.render({ path: "transparent.png", format: "png" });
    const webp = await service.render({ path: "transparent.png", format: "webp" });

    expect(png.output_mime_type).toBe("image/png");
    expect(webp.output_mime_type).toBe("image/webp");
    expect((await sharp(png.bytes).stats()).isOpaque).toBe(false);
    expect((await sharp(webp.bytes).stats()).isOpaque).toBe(false);
  });

  test("returns a size error instead of changing a forced PNG or WebP MIME type", async () => {
    const root = await createRoot();
    await writeNoisyAlphaPng(join(root, "forced-format.png"), 320, 240);
    const service = new ImageRenderService(new PathSandbox(root), root, { maxBase64Bytes: 10_000 });

    for (const format of ["png", "webp"] as const) {
      await expect(service.render({ path: "forced-format.png", format })).rejects.toMatchObject({ code: "IMAGE_RESULT_TOO_LARGE" } satisfies Partial<RepoReaderError>);
    }
  });

  test("returns a labelled checkerboard-flattened preview when alpha WebP cannot fit", async () => {
    const root = await createRoot();
    await writeNoisyAlphaPng(join(root, "large-alpha.png"));
    const service = new ImageRenderService(new PathSandbox(root), root, { maxBase64Bytes: 10_000 });

    const result = await service.render({ path: "large-alpha.png" });

    expect(result.transparency_mode).toBe("flattened");
    expect(result.output_mime_type).toBe("image/jpeg");
    expect(result.warnings.join(" ")).toContain("checkerboard");
    expect((await sharp(result.bytes).stats()).isOpaque).toBe(true);
    const raw = await sharp(result.bytes).raw().toBuffer();
    expect(raw[0]).toBeGreaterThan(175);
    expect(Math.abs(raw[0]! - raw[1]!)).toBeLessThan(10);
    expect(Math.abs(raw[1]! - raw[2]!)).toBeLessThan(10);
  });

  test("keeps image reads inside existing exclusion and secret path policy", async () => {
    const root = await createRoot();
    await mkdir(join(root, "node_modules"), { recursive: true });
    await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } }).png().toFile(join(root, "node_modules", "blocked.png"));
    const service = new ImageRenderService(new PathSandbox(root), root);

    await expect(service.render({ path: "node_modules/blocked.png" })).rejects.toMatchObject({ code: "DEFAULT_EXCLUDE_BLOCKED" } satisfies Partial<RepoReaderError>);
  });

  test("honors repository-local MCP ignore patterns", async () => {
    const root = await createRoot();
    await mkdir(join(root, "private-images"), { recursive: true });
    await writeFile(join(root, ".repo-mcpignore"), "private-images/**\n");
    await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } }).png().toFile(join(root, "private-images", "blocked.png"));
    const service = new ImageRenderService(new PathSandbox(root), root);

    await expect(service.render({ path: "private-images/blocked.png" })).rejects.toMatchObject({ code: "DEFAULT_EXCLUDE_BLOCKED" } satisfies Partial<RepoReaderError>);
  });

  test("caps raw encoded output at the Base64 transport budget", async () => {
    const root = await createRoot();
    await sharp({ create: { width: 200, height: 100, channels: 3, background: "#111111" } }).png().toFile(join(root, "budget.png"));
    const result = await new ImageRenderService(new PathSandbox(root), root).render({ path: "budget.png" });

    expect(4 * Math.ceil(result.output_bytes / 3)).toBeLessThanOrEqual(MAX_IMAGE_BASE64_BYTES);
  });
});

async function createRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "gpt-repo-mcp-images-"));
}

async function writeNoisyAlphaPng(path: string, width = 384, height = 288): Promise<void> {
  const pixels = Buffer.alloc(width * height * 4);
  let state = 0x12345678;
  for (let index = 0; index < pixels.length; index += 4) {
    const pixel = index / 4;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    pixels[index] = state & 255;
    pixels[index + 1] = (state >>> 8) & 255;
    pixels[index + 2] = (state >>> 16) & 255;
    pixels[index + 3] = x < 96 && y < 96 ? 0 : 255;
  }
  await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(path);
}
