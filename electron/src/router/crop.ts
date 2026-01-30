import fs from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';

import { Router } from '@modules/router';
import routerConfig from '@root/router-config';

const r = new Router();

type CropMode = 'two_3x4' | 'three_3x5' | 'custom';

interface CropSplitReq {
  path: string;
  outputDir: string;
  mode: CropMode;
  cropW?: number;
  cropH?: number;
  parts?: number;
  cropRect?: { left: number; top: number; width: number; height: number };
  quality?: number;
}

interface ModeDef {
  cropW: number;
  cropH: number;
  parts: number;
}

const MODE_DEF: Record<CropMode, ModeDef> = {
  // Note: to get 2x 3:4 portrait pieces seamlessly, the horizontal crop must be 3:2.
  two_3x4: { cropW: 3, cropH: 2, parts: 2 },
  three_3x5: { cropW: 9, cropH: 5, parts: 3 },
  custom: { cropW: 9, cropH: 5, parts: 3 },
};

function resolveModeDef(data: CropSplitReq): ModeDef {
  if (data.mode !== 'custom') {
    return MODE_DEF[data.mode];
  }

  const cropW = Number(data.cropW);
  const cropH = Number(data.cropH);
  const parts = Number(data.parts);
  if (!Number.isFinite(cropW) || cropW <= 0) throw new Error('cropSplit: cropW is invalid');
  if (!Number.isFinite(cropH) || cropH <= 0) throw new Error('cropSplit: cropH is invalid');
  if (![2, 3].includes(parts)) throw new Error('cropSplit: parts must be 2 or 3');
  return { cropW, cropH, parts };
}

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n | 0));
}

function clampExtractRect(w: number, h: number, rect: { left: number; top: number; width: number; height: number }) {
  const width = clampInt(Math.round(rect.width), 1, w);
  const height = clampInt(Math.round(rect.height), 1, h);
  const left = clampInt(Math.round(rect.left), 0, w - width);
  const top = clampInt(Math.round(rect.top), 0, h - height);
  return { left, top, width, height };
}

function approxEq(a: number, b: number, eps = 1e-3) {
  return Math.abs(a - b) <= eps;
}

function centerCropRect(w: number, h: number, targetRatio: number) {
  if (w <= 0 || h <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }

  const r = w / h;
  let cw = w;
  let ch = h;
  if (r > targetRatio) {
    cw = Math.round(h * targetRatio);
  } else {
    ch = Math.round(w / targetRatio);
  }

  cw = clampInt(cw, 1, w);
  ch = clampInt(ch, 1, h);

  const left = clampInt(Math.floor((w - cw) / 2), 0, w - cw);
  const top = clampInt(Math.floor((h - ch) / 2), 0, h - ch);
  return { left, top, width: cw, height: ch };
}

r.listen<CropSplitReq, string[]>(routerConfig.cropSplit, async (data) => {
  if (!data?.path) throw new Error('cropSplit: path is required');
  if (!data?.outputDir) throw new Error('cropSplit: outputDir is required');
  if (!data?.mode) throw new Error('cropSplit: mode is required');

  if (!fs.existsSync(data.path)) {
    throw new Error('cropSplit: file not exists');
  }
  if (!fs.existsSync(data.outputDir)) {
    fs.mkdirSync(data.outputDir, { recursive: true });
  }

  const def = resolveModeDef(data);

  const targetRatio = def.cropW / def.cropH;
  const quality = Number.isFinite(Number(data.quality)) ? Number(data.quality) : 92;

  const img = sharp(data.path).rotate();
  const meta = await img.metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  if (!w || !h) throw new Error('cropSplit: unable to read image size');

  let crop = centerCropRect(w, h, targetRatio);
  if (data.cropRect) {
    const cr = clampExtractRect(w, h, data.cropRect);
    const r = cr.width / cr.height;
    // Enforce aspect ratio (slices must be stitchable). If mismatch, fallback to center crop.
    if (approxEq(r, targetRatio, 1e-3)) {
      crop = cr;
    }
  }

  const base = sharp(data.path)
    .rotate()
    .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height });

  const partW = Math.floor(crop.width / def.parts);
  const outPaths: string[] = [];

  const parsed = path.parse(data.path);
  const baseName = parsed.name;
  for (let i = 0; i < def.parts; i++) {
    const left = i * partW;
    const width = i === def.parts - 1 ? crop.width - partW * (def.parts - 1) : partW;
    const piece = await base
      .clone()
      .extract({ left, top: 0, width, height: crop.height })
      .jpeg({ quality })
      .toBuffer();

    const outName = `${baseName}_part_${i + 1}_of_${def.parts}.jpg`;
    const outPath = path.join(data.outputDir, outName);
    fs.writeFileSync(outPath, piece);
    outPaths.push(outPath);
  }

  return outPaths;
});

export default r;
