import { TextTool } from '@web/modules/text-tool';
import { createCanvas, loadImage } from '@web/util/util';

import type { Exif } from '@modules/exiftool/interface';
import type { IConfig } from '@web/main/interface';

type PreviewResult = {
  url: string
  revoke?: () => void
}

type SizeInfo = {
  w: number
  h: number
  resetW: number
  resetH: number
}

type Material = {
  bg: { w: number, h: number }
  main: { w: number, h: number, top: number, left: number }
  text: { w: number, h: number, data: string }[]
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function numOr(v: unknown, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function calcBgImgSize(sizeInfo: SizeInfo, opt: IConfig['options'], height?: number) {
  let resetHeight = sizeInfo.resetH;
  let resetWidth = sizeInfo.resetW;
  const whRate = resetWidth / resetHeight;

  if (height) {
    resetHeight = height;
    resetWidth = Math.ceil(resetHeight * whRate);
  } else {
    const validHeight = sizeInfo.h > resetHeight ? sizeInfo.h : resetHeight;
    resetHeight = validHeight;
    resetWidth = Math.ceil(resetHeight * whRate);
  }

  const mainImgWidthRate = (opt.main_img_w_rate || 90) / 100;
  if (sizeInfo.w / resetWidth > mainImgWidthRate) {
    resetWidth = Math.ceil(sizeInfo.w / mainImgWidthRate);
    resetHeight = Math.ceil(resetWidth / whRate);
  }

  return { w: resetWidth, h: resetHeight };
}

function calcContentHeight(material: Material, opt: IConfig['options']) {
  const bgHeight = material.bg.h;
  const mainImgTopOffset = bgHeight * (opt.mini_top_bottom_margin / 100);
  const textButtomOffset = bgHeight * 0.027;

  let contentTop = Math.ceil(mainImgTopOffset);
  let mainImgOffset = contentTop * 2;

  if (opt.shadow_show) {
    const shadowHeight = Math.ceil(material.main.h * ((opt.shadow || 0) / 100));
    contentTop = Math.max(contentTop, Math.ceil(shadowHeight));
    mainImgOffset = contentTop * 2;
  }

  if (material.text.length) {
    mainImgOffset *= 3 / 4;
    mainImgOffset += textButtomOffset;
  }

  const textH = material.text.reduce((n, i) => n + i.h, 0);
  const contentH = Math.ceil(textH + material.main.h + mainImgOffset);

  material.main.top = contentTop;

  if (material.text.length) {
    material.text[material.text.length - 1].h += textButtomOffset;
  }

  return { contentH };
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

function calcAverageBrightness(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  let totalBrightness = 0;
  for (let i = 0; i < data.length; i += 4) {
    totalBrightness += (data[i] + data[i + 1] + data[i + 2]) / 3;
  }
  return totalBrightness / (width * height);
}

export async function genPreviewGpuLike(opts: {
  path: string
  maxSize?: number
  quality?: number
  config: IConfig
  exif: Exif | undefined
  logoPath: string
}): Promise<PreviewResult> {
  const maxSize = Math.max(200, Math.floor(opts.maxSize || 1100));
  const quality = clamp(Math.floor(opts.quality || 0.82 * 100), 30, 100) / 100;
  const conf = opts.config;
  const opt = conf.options;

  const img = await loadImage(opts.path);
  let sizeInfo: SizeInfo = {
    w: img.width,
    h: img.height,
    resetW: img.width,
    resetH: img.height,
  };

  if (opt.bg_rate_show && opt.bg_rate?.w && opt.bg_rate?.h) {
    const rate = (+opt.bg_rate.w) / (+opt.bg_rate.h);
    if (sizeInfo.w >= sizeInfo.h) {
      sizeInfo.resetH = Math.round(sizeInfo.w / rate);
    } else {
      sizeInfo.resetW = Math.round(sizeInfo.h * rate);
    }
  }

  if (opt.landscape && sizeInfo.resetW < sizeInfo.resetH) {
    const w = sizeInfo.resetH;
    const h = sizeInfo.resetW;
    sizeInfo.resetW = w;
    sizeInfo.resetH = h;
  }

  const baseMax = Math.max(sizeInfo.w, sizeInfo.h, sizeInfo.resetW, sizeInfo.resetH);
  const scale = baseMax ? Math.min(1, maxSize / baseMax) : 1;
  if (scale < 1) {
    sizeInfo = {
      w: Math.max(1, Math.round(sizeInfo.w * scale)),
      h: Math.max(1, Math.round(sizeInfo.h * scale)),
      resetW: Math.max(1, Math.round(sizeInfo.resetW * scale)),
      resetH: Math.max(1, Math.round(sizeInfo.resetH * scale)),
    };
  }

  // downscale once; reuse for all draws (faster than repeatedly sampling huge image)
  const mainSrc = createCanvas(sizeInfo.w, sizeInfo.h);
  const mainSrcCtx = mainSrc.getContext('2d');
  if (!mainSrcCtx) {
    throw new Error('canvas context not available');
  }
  mainSrcCtx.drawImage(img, 0, 0, sizeInfo.w, sizeInfo.h);

  // first-pass bg size (for text layout)
  const bg0 = calcBgImgSize(sizeInfo, opt);

  const textTool = new TextTool((opts.exif || {}) as any, {
    bgHeight: bg0.h,
    options: opt,
    fields: [...(conf.tempFields || []), ...(conf.customTempFields || [])],
    temps: conf.temps || [],
    logoPath: opts.logoPath,
  } as any);
  const textImgList = (await textTool.genTextImg()) || [];

  const material: Material = {
    bg: { w: bg0.w, h: bg0.h },
    main: { w: sizeInfo.w, h: sizeInfo.h, top: 0, left: 0 },
    text: textImgList.map((t) => ({ w: t.w, h: t.h, data: t.data })),
  };

  const { contentH } = calcContentHeight(material, opt);
  const bg1 = calcBgImgSize(sizeInfo, opt, contentH);
  material.bg = { w: bg1.w, h: bg1.h };
  material.main.left = Math.round((material.bg.w - material.main.w) / 2);
  material.main.top += Math.round((material.bg.h - contentH) / 2);

  // paint
  const canvas = createCanvas(material.bg.w, material.bg.h);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas context not available');
  }

  // bg
  if (opt.solid_bg) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    const blurPx = Math.max(12, Math.round(30 * Math.max(0.5, scale)));
    ctx.filter = `blur(${blurPx}px)`;
    ctx.drawImage(mainSrc, 0, 0, canvas.width, canvas.height);
    ctx.filter = 'none';
  }

  // compute overlay color using bg only
  let overlayFillStyle: string | null = null;
  if (!opt.solid_bg) {
    const averageBrightness = calcAverageBrightness(ctx, canvas.width, canvas.height);
    if (averageBrightness < 15) {
      overlayFillStyle = 'rgba(180, 180, 180, 0.2)';
    } else if (averageBrightness < 20) {
      overlayFillStyle = 'rgba(158, 158, 158, 0.2)';
    } else if (averageBrightness < 40) {
      overlayFillStyle = 'rgba(128, 128, 128, 0.2)';
    } else {
      overlayFillStyle = 'rgba(0, 0, 0, 0.2)';
    }
  }

  // main first
  ctx.drawImage(mainSrc, material.main.left, material.main.top, material.main.w, material.main.h);

  // overlay + shadow + hole (like genMainImgShadow)
  if (overlayFillStyle) {
    ctx.fillStyle = overlayFillStyle;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.fillStyle = 'black';

  const blur = opt.shadow_show ? material.main.h * ((opt.shadow || 6) / 100) : 0;
  if (blur) {
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.shadowBlur = blur;
    ctx.shadowColor = 'rgba(0, 0, 0, 1)';
  } else {
    ctx.shadowBlur = 0;
  }

  const rectX = material.main.left || ctx.shadowBlur;
  const rectY = material.main.top || ctx.shadowBlur;
  const rectWidth = material.main.w;
  const rectHeight = material.main.h;
  const radiusPct = numOr(opt.radius, 2.1);
  const cornerRadius = opt.radius_show ? material.main.h * (radiusPct / 100) : 0;

  ctx.save();
  roundRectPath(ctx, rectX, rectY, rectWidth, rectHeight, cornerRadius);
  ctx.fill();

  roundRectPath(ctx, rectX, rectY, rectWidth, rectHeight, cornerRadius);
  ctx.clip();
  ctx.clearRect(rectX, rectY, rectWidth, rectHeight);
  ctx.restore();

  // redraw main on top to ensure hole shows main
  ctx.shadowBlur = 0;
  ctx.drawImage(mainSrc, material.main.left, material.main.top, material.main.w, material.main.h);

  // texts (bottom-up)
  if (material.text.length) {
    let currentTop = material.bg.h;
    for (let i = material.text.length - 1; i >= 0; i--) {
      const t = material.text[i];
      const tImg = await loadImage(t.data);
      // NOTE: t.h may include extra bottom padding for layout; never stretch the bitmap.
      const drawW = tImg.width || t.w;
      const drawH = tImg.height || t.h;
      const left = Math.round((material.bg.w - drawW) / 2);
      const top = Math.round(currentTop - t.h);
      ctx.drawImage(tImg, left, top, drawW, drawH);
      currentTop = top;
    }
  }

  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', quality);
  });
  const url = URL.createObjectURL(blob);
  return { url, revoke: () => URL.revokeObjectURL(url) };
}
