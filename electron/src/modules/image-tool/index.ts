import Event from 'events';
import fs from 'fs';
import { join } from 'path';

import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import { ExifTool } from '@modules/exiftool';
import { Exif } from '@modules/exiftool/interface';
import { Logger } from '@modules/logger';
import routerConfig from '@root/router-config';
import { mainApp } from '@src/common/app';
import { genMainImgShadowQueue, genTextImgQueue } from '@src/common/queue';
import { config } from '@src/config';
import { IConfig } from '@src/interface';
import paths from '@src/path';
import { getFileName, md5, tryCatch, usePromise } from '@utils';
import fluentFfmpeg from 'fluent-ffmpeg';
import type { RGBA } from 'sharp';
import sharp from 'sharp';

import type { ImageToolOption, Material, OutputFilePaths, SizeInfo } from './interface';

const log = new Logger('ImageTool');
const NotInit = Symbol('未初始化');

interface EventMap {
  progress(id: string, progress: number): void
}

export class ImageTool extends Event {
  private isInit: boolean;

  private previewScale = 1;

  readonly id: string;

  readonly path: string;

  readonly name: string;

  private outputOpt: IConfig['options'];

  private outputFileNames: OutputFilePaths;

  private meta: sharp.Metadata;

  private sizeInfo: SizeInfo;

  private blur = 200;

  private exif: Exif;

  private _progress = 0;

  private material: Material = {
    bg: undefined,
    main: [],
    text: [],
  };

  private contentH: number;

  set progress(n: number) {
    this._progress = n;
    this.emit('progress', this.id, this._progress);
  }

  constructor(path: string, name: string, opt: ImageToolOption) {
    super();

    this.path = path;
    this.name = name;
    this.outputOpt = opt.outputOption;
    this.id = md5(`${md5(path)}${Math.random()}${Date.now()}`);

    const baseFilePath = join(opt.cachePath, this.id);
    this.outputFileNames = {
      base: baseFilePath,
      bg: `${baseFilePath}_bg.jpg`,
      main: `${baseFilePath}_main.jpg`,
      mask: `${baseFilePath}_mask.png`,
      composite: join(opt.outputPath, getFileName(opt.outputPath, name)),
    };
  }

  async init() {
    if (this.isInit) return;
    this.isInit = true;

    // 准备基础信息
    const imgSharp = sharp(this.path).rotate();

    this.meta = await imgSharp.metadata();
    const { info: imgInfo } = await imgSharp.toBuffer({ resolveWithObject: true });
    this.sizeInfo = {
      w: imgInfo.width,
      h: imgInfo.height,
      resetW: imgInfo.width,
      resetH: imgInfo.height,
    };

    const { outputOpt } = this;

    // 重置宽高比
    if (outputOpt.bg_rate_show && outputOpt.bg_rate.w && outputOpt.bg_rate.h) {
      const rate = +outputOpt.bg_rate.w / +outputOpt.bg_rate.h;

      if (this.sizeInfo.w >= this.sizeInfo.h) {
        this.sizeInfo.resetH = Math.round(this.sizeInfo.w / rate);
      } else {
        this.sizeInfo.resetW = Math.round(this.sizeInfo.h * rate);
      }
    }

    // 横屏输出
    const width = outputOpt.landscape && this.sizeInfo.resetW < this.sizeInfo.resetH
      ? this.sizeInfo.resetH
      : this.sizeInfo.resetW;
    const height = outputOpt.landscape && this.sizeInfo.resetW < this.sizeInfo.resetH
      ? this.sizeInfo.resetW
      : this.sizeInfo.resetH;

    this.sizeInfo.resetW = width;
    this.sizeInfo.resetH = height;

    // 获取相机信息
    const exiftool = new ExifTool(this.path);
    this.exif = exiftool.parse();
  }

  async genWatermark() {
    this.progress = 1;
    log.info('【%s】初始化基础数据', this.id);
    await this.init();
    this.progress = 10;

    log.info('【%s】初步计算背景图片大小', this.id);
    this.clacBgImgSize();
    this.progress = 20;

    log.info('【%s】生成文本图片', this.id);
    await this.genTextImg();
    this.progress = 30;

    log.info('【%s】生成主图', this.id);
    await this.genMainImg();
    this.progress = 50;

    log.info('【%s】计算内容高度', this.id);
    this.calcContentHeight();
    this.progress = 60;

    log.info('【%s】生成背景图', this.id);
    await this.genBgImg();
    this.progress = 70;

    log.info('【%s】生成主图阴影遮罩', this.id);
    await this.genMainImgShadow();
    this.progress = 90;

    log.info('【%s】图片合成...', this.id);
    await this.composite();
    this.progress = 100;

    this.delCacheFile();
  }

  async genPreview(opts?: { maxSize?: number, quality?: number }) {
    const maxSize = Math.max(200, Math.floor(opts?.maxSize || 1100));
    const quality = Math.max(30, Math.min(100, Math.floor(opts?.quality || 80)));

    await this.init();

    // 预览模式：尽早把所有尺寸缩到 maxSize 附近，避免后续生成超大中间图导致卡顿
    const baseMax = Math.max(
      this.sizeInfo.w || 0,
      this.sizeInfo.h || 0,
      this.sizeInfo.resetW || 0,
      this.sizeInfo.resetH || 0,
    );
    const scale = baseMax ? Math.min(1, maxSize / baseMax) : 1;
    this.previewScale = scale;
    if (scale < 1) {
      this.sizeInfo.w = Math.max(1, Math.round(this.sizeInfo.w * scale));
      this.sizeInfo.h = Math.max(1, Math.round(this.sizeInfo.h * scale));
      this.sizeInfo.resetW = Math.max(1, Math.round(this.sizeInfo.resetW * scale));
      this.sizeInfo.resetH = Math.max(1, Math.round(this.sizeInfo.resetH * scale));
    }

    this.clacBgImgSize();
    await this.genTextImg();
    await this.genMainImg();
    this.calcContentHeight();
    await this.genBgImg({ fast: true });
    await this.genMainImgShadow();

    const buf = await this.compositeToBuffer({ maxSize, quality });
    this.delCacheFile(false);
    return buf;
  }

  async genBgImg(opts?: { fast?: boolean }) {
    const toFilePath: string = this.outputFileNames.bg;
    this.clacBgImgSize(this.contentH);
    const { w, h } = this.material.bg;

    if (this.outputOpt.solid_bg) {
      await this.genSolidImg(w, h, toFilePath);
    } else {
      await (opts?.fast ? this.genBlurImgFast(w, h, toFilePath) : this.genBlurImg(w, h, toFilePath));
    }

    this.material.main[0].left = Math.round((this.material.bg.w - this.material.main[0].w) / 2);
    this.material.main[0].top += Math.round((this.material.bg.h - this.contentH) / 2);
  }

  private async genBlurImgFast(width: number, height: number, toFilePath: string) {
    // 预览模式：避免 ffmpeg，大幅提速（效果与最终输出可能略有差异）
    await sharp(this.path)
      .rotate()
      .resize({ width, height, fit: 'fill' })
      .blur(30)
      .toFormat('jpeg', { quality: 60 })
      .toFile(toFilePath);
  }

  async genMainImg() {
    const toFilePath: string = this.outputFileNames.main;
    if (!this.isInit) throw NotInit;
    const s = sharp(this.path)
      .rotate()
      .withMetadata({ density: this.meta.density });

    // 预览模式：直接输出缩小后的主图缓存，显著提速
    if (this.previewScale < 1) {
      await s
        .resize({ width: this.sizeInfo.w, height: this.sizeInfo.h, fit: 'fill' })
        .toFormat('jpeg', { quality: 90 })
        .toFile(toFilePath);
    } else {
      await s
        .toFormat('jpeg', { quality: 100 })
        .toFile(toFilePath);
    }

    this.material.main.push({
      path: toFilePath,
      w: this.sizeInfo.w,
      h: this.sizeInfo.h,
      top: 0,
      left: 0,
    });
  }

  async genTextImg() {
    const [p, r, j] = usePromise();
    let timer: NodeJS.Timeout;

    const handler: Parameters<typeof genTextImgQueue.on>[number] = async ({ id, textImgList = [] }) => {
      if (id === this.id) {
        this.material.text = textImgList.map((i) => ({
          path: '',
          buf: Buffer.from(i.data.split(',')[1], 'base64'),
          w: i.w,
          h: i.h,
          top: 0,
          left: 0,
        }));

        if (import.meta.env.DEV) {
          tryCatch(() => {
            for (const { buf } of this.material.text) {
              fs.writeFileSync(join(`${this.outputFileNames.base}_${Date.now() + Math.random()}.png`), buf);
            }
          }, null, (e) => log.error('文字图片写入异常', e));
        }

        clearTimeout(timer);
        genTextImgQueue.off(handler);
        r(true);
      }
    };

    timer = setTimeout(() => {
      log.error('【%s】水印文字图片生成超时', this.id);
      genTextImgQueue.off(handler);
      j(new Error('水印文字图片生成超时'));
    }, 20e3);

    genTextImgQueue.on(handler);

    mainApp.win.webContents.send(routerConfig.on.genTextImg, {
      id: this.id,
      exif: this.exif || {},
      bgHeight: this.material.bg.h,
      options: config.options,
      fields: [...config.tempFields, ...config.customTempFields],
      temps: config.temps,
      logoPath: paths.logo,
    });

    return p;
  }

  async composite() {
    const composite = await this.buildCompositeList(false);

    await sharp({
      create: {
        channels: 3,
        width: this.material.bg.w,
        height: this.material.bg.h,
        background: {
          r: 255,
          g: 255,
          b: 255,
        },
      },
    })
      .withMetadata({ density: this.meta.density })
      .composite(composite)
      .toFormat('jpeg', { quality: this.outputOpt.quality || 100 })
      .toFile(this.outputFileNames.composite);

    log.info('【%s】图片合成完毕，输出到文件: ', this.id, this.outputFileNames.composite);
    return true;
  }

  private async compositeToBuffer(opts: { maxSize: number, quality: number }) {
    // 预览场景：强制兜底缩放，避免因某一层尺寸/偏移异常导致 sharp 直接报错
    const composite = await this.buildCompositeList(true);

    const bgW = this.material.bg.w;
    const bgH = this.material.bg.h;
    const scale = Math.min(1, opts.maxSize / Math.max(bgW, bgH));
    const outW = Math.max(1, Math.round(bgW * scale));
    const outH = Math.max(1, Math.round(bgH * scale));

    const createBase = () => sharp({
      create: {
        channels: 3,
        width: outW,
        height: outH,
        background: {
          r: 255,
          g: 255,
          b: 255,
        },
      },
    }).withMetadata({ density: this.meta.density });

    const scaledComposite: sharp.OverlayOptions[] = await Promise.all(composite.map(async (c) => {
      const input = c.input as any;
      const gravity = (c as any).gravity;
      const top = (c as any).top as number | undefined;
      const left = (c as any).left as number | undefined;

      // 遮罩：直接缩放到与底图一致（用 top/left 固定为 0，避免 gravity + 等尺寸时触发某些 vips 边界问题）
      if (typeof gravity !== 'undefined') {
        const buf = await sharp(input)
          .rotate()
          .resize({ width: outW, height: outH, fit: 'fill' })
          .png()
          .toBuffer();
        return { input: buf, top: 0, left: 0 };
      }

      const meta = await sharp(input).rotate().metadata();
      const w = meta.width || 1;
      const h = meta.height || 1;
      const sw = Math.max(1, Math.round(w * scale));
      const sh = Math.max(1, Math.round(h * scale));

      const isPng = meta.format === 'png';
      const pipeline = sharp(input)
        .rotate()
        .resize({ width: sw, height: sh, fit: 'fill' });

      const buf = await (isPng ? pipeline.png() : pipeline).toBuffer();

      return {
        input: buf,
        top: typeof top === 'number' ? Math.max(0, Math.round(top * scale)) : undefined,
        left: typeof left === 'number' ? Math.max(0, Math.round(left * scale)) : undefined,
      };
    }));

    // 快速路径：在缩小后的画布上一次性合成
    try {
      return await createBase()
        .composite(scaledComposite)
        .toFormat('jpeg', { quality: opts.quality })
        .toBuffer();
    } catch (e) {
      // 兜底：逐层合成（同样在缩小后的画布上执行，避免大图超慢）
      try {
        let buf = await createBase().png().toBuffer();
        for (let i = 0; i < scaledComposite.length; i++) {
          buf = await sharp(buf)
            .composite([scaledComposite[i]])
            .png()
            .toBuffer();
        }

        log.warn('【%s】预览合成走兜底路径（缩放=%s，bg=%sx%s -> %sx%s）', this.id, scale.toFixed(3), bgW, bgH, outW, outH);
        return await sharp(buf)
          .toFormat('jpeg', { quality: opts.quality })
          .toBuffer();
      } catch {
        // only log details when BOTH paths fail
        log.error('【%s】预览合成失败，bg=%sx%s', this.id, bgW, bgH);
        try {
          const details = await Promise.all(composite.map(async (c, idx) => {
            try {
              const meta = await sharp(c.input as any).rotate().metadata();
              return {
                idx,
                w: meta.width,
                h: meta.height,
                top: (c as any).top,
                left: (c as any).left,
                gravity: (c as any).gravity,
              };
            } catch {
              return {
                idx,
                w: null,
                h: null,
                top: (c as any).top,
                left: (c as any).left,
                gravity: (c as any).gravity,
              };
            }
          }));
          log.error('【%s】预览 composite 详情: %j', this.id, details);
        } catch {
          // ignore
        }
        throw e;
      }
    }
  }

  private async buildCompositeList(forceFitToBg = false) {
    const composite: sharp.OverlayOptions[] = [];

    const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

    const ensureFitToBg = async (input: string | Buffer, maxW: number, maxH: number, label: string) => {
      try {
        // forceFitToBg=true 时，不信任 meta，直接做一次 inside 缩放兜底（withoutEnlargement 保证不放大）
        if (forceFitToBg) {
          const resized = await sharp(input as any)
            // 应用 EXIF 方向，避免“视觉尺寸”大于底图导致 composite 报错
            .rotate()
            .resize({ width: maxW, height: maxH, fit: 'inside', withoutEnlargement: true })
            .toBuffer({ resolveWithObject: true });
          return { input: resized.data as Buffer, width: resized.info.width, height: resized.info.height, resized: true };
        }

        const meta = await sharp(input as any).rotate().metadata();
        const w = meta.width || 0;
        const h = meta.height || 0;
        if (w && h && (w > maxW || h > maxH)) {
          log.warn('【%s】%s 尺寸超过底图，自动缩放: %sx%s -> <=%sx%s', this.id, label, w, h, maxW, maxH);
          const resized = await sharp(input as any)
            .rotate()
            .resize({ width: maxW, height: maxH, fit: 'inside', withoutEnlargement: true })
            .toBuffer({ resolveWithObject: true });
          return { input: resized.data as Buffer, width: resized.info.width, height: resized.info.height, resized: true };
        }
        return { input, width: w, height: h, resized: false };
      } catch (e) {
        log.warn('【%s】%s 元数据读取失败，跳过自适应: %s', this.id, label, (e as any)?.message || e);
        // 最后兜底：强制做一次 inside 缩放，确保不炸 composite
        try {
          const resized = await sharp(input as any)
            .rotate()
            .resize({ width: maxW, height: maxH, fit: 'inside', withoutEnlargement: true })
            .toBuffer({ resolveWithObject: true });
          return { input: resized.data as Buffer, width: resized.info.width, height: resized.info.height, resized: true };
        } catch {
          return { input, width: 0, height: 0, resized: false };
        }
      }
    };

    // 主图
    for (const img of this.material.main) {
      // 兜底：主图比底图大时会导致 sharp composite 报错
      const fitted = await ensureFitToBg(img.path, this.material.bg.w, this.material.bg.h, '主图');
      const w = fitted.width || img.w;
      const h = fitted.height || img.h;
      const left = clamp(Math.round((this.material.bg.w - w) / 2), 0, Math.max(0, this.material.bg.w - w));
      const top = clamp(Math.round(img.top), 0, Math.max(0, this.material.bg.h - h));
      composite.push({ input: fitted.input, top, left });
    }

    // 遮罩(兜底保证不大于底图，避免 sharp 报错)
    let maskInput: string | Buffer = this.outputFileNames.mask;
    try {
      // 遮罩用于覆盖底图，直接 resize 到与底图一致最稳
      if (forceFitToBg) {
        maskInput = await sharp(this.outputFileNames.mask)
          .rotate()
          .resize({ width: this.material.bg.w, height: this.material.bg.h, fit: 'fill' })
          .png()
          .toBuffer();
      } else {
        const meta = await sharp(this.outputFileNames.mask).metadata();
        if (meta.width && meta.height && (meta.width > this.material.bg.w || meta.height > this.material.bg.h)) {
          maskInput = await sharp(this.outputFileNames.mask)
            .rotate()
            .resize({ width: this.material.bg.w, height: this.material.bg.h, fit: 'fill' })
            .png()
            .toBuffer();
        }
      }
    } catch {
      // ignore
    }
    composite.push({ input: maskInput, gravity: sharp.gravity.center });

    // 文字(兜底缩放到背景内，避免 "image to composite must have same dimensions or smaller")
    if (this.material.text?.length) {
      const maxTextW = Math.max(10, this.material.bg.w - 40);
      const textCompositeList: sharp.OverlayOptions[] = [];

      for (let i = this.material.text.length - 1; i >= 0; i--) {
        const text = this.material.text[i];
        // 先按宽度缩放一轮，再做一次真实尺寸兜底（避免传入的 w/h 与实际 png 尺寸不一致）
        let input: Buffer = text.buf;
        if (text.w > maxTextW) {
          input = await sharp(text.buf)
            .resize({ width: maxTextW, fit: 'inside', withoutEnlargement: true })
            .png()
            .toBuffer();
        }

        const fitted = await ensureFitToBg(input, this.material.bg.w, this.material.bg.h, '文字');
        input = fitted.input as Buffer;
        const w = fitted.width || Math.min(text.w, this.material.bg.w);
        const h = fitted.height || Math.min(text.h, this.material.bg.h);

        const _composite: sharp.OverlayOptions = {
          input,
          left: clamp(Math.round((this.material.bg.w - w) / 2), 0, Math.max(0, this.material.bg.w - w)),
        };

        if (!textCompositeList.length) {
          _composite.top = clamp(Math.round(this.material.bg.h - h), 0, Math.max(0, this.material.bg.h - h));
        } else {
          _composite.top = clamp(
            Math.round((textCompositeList[textCompositeList.length - 1].top as number) - h),
            0,
            Math.max(0, this.material.bg.h - h),
          );
        }

        textCompositeList.push(_composite);
      }

      composite.push(...textCompositeList);
    }

    return composite;
  }

  private getFFmpeg() {
    const _path = ffmpegPath.path.includes('app.asar') ? ffmpegPath.path.replace('app.asar', 'app.asar.unpacked') : ffmpegPath.path;
    fluentFfmpeg.setFfmpegPath(_path);
    return fluentFfmpeg();
  }

  private async genBlurImg(width: number, height: number, toFilePath: string) {
    const ffmpeg = this.getFFmpeg();

    // 统一转成固定大小，方便控制模糊数值
    await sharp(this.path)
      .rotate()
      .resize({ width: 3025, height: 3025, fit: 'fill' })
      .toFormat('jpeg', { quality: 50 })
      .toFile(toFilePath);

    const [promise, r] = usePromise();

    /**
     * luma_radius (lr)：控制在亮度（Luma）通道上的模糊半径。它决定了在视频的亮度通道上应用模糊的程度。较大的值将导致更大的模糊效果。默认值为 2。
     * chroma_radius (cr)：控制在色度（Chroma）通道上的模糊半径。它决定了在视频的色度通道上应用模糊的程度。较大的值将导致更大的模糊效果。默认值为 2。
     * luma_power (lp)：控制在亮度通道上应用模糊的程度。较大的值将导致更多的模糊效果。默认值为 1。chroma_radius (cr)：控制在色度（Chroma）通道上的模糊半径。它决定了在视频的色度通道上应用模糊的程度。较大的值将导致更大的模糊效果。默认值为 2。
     * chroma_power (cp)：控制在色度通道上应用模糊的程度。较大的值将导致更多的模糊效果。默认值为 1。
     */
    // 模糊
    ffmpeg.input(toFilePath)
      .outputOptions('-vf', `boxblur=${this.blur}:2`)
      .saveToFile(toFilePath)
      .on('end', () => r(true))
      .on('error', (e) => {
        log.error('FFmpeg模糊异常', e);
        r(false);
      });

    if (!await promise) return;

    const buf = await sharp(toFilePath)
      .resize({ width, height, fit: 'fill' })
      .toBuffer();
    fs.writeFileSync(toFilePath, buf);
  }

  private async genSolidImg(width: number, height: number, toFilePath: string, color?: string | RGBA) {
    return sharp({
      create: {
        channels: 3,
        width,
        height,
        background: (typeof color === 'string' ? color : this.outputOpt.solid_color) || '#fff',
      },
    })
      .toFormat('jpeg')
      .toFile(toFilePath);
  }

  private delCacheFile(keepComposite = true) {
    for (const k in this.outputFileNames) {
      if (keepComposite && k === 'composite') continue;

      const _path = (this.outputFileNames as any)[k];
      if (fs.existsSync(_path)) {
        tryCatch(() => fs.rmSync(_path));
      }
    }
  }

  async genMainImgShadow() {
    const [p, r, j] = usePromise();
    let timer: NodeJS.Timeout;

    const handler: Parameters<typeof genMainImgShadowQueue.on>[number] = async ({ id, data }) => {
      if (id === this.id) {
        fs.writeFileSync(this.outputFileNames.mask, Buffer.from(data.split(',')[1], 'base64'));
        clearTimeout(timer);
        r(true);
        genMainImgShadowQueue.off(handler);
      }
    };

    timer = setTimeout(() => {
      log.error('【%s】图片阴影生成超时', this.id);
      genMainImgShadowQueue.off(handler);
      j(new Error('图片阴影生成超时'));
    }, 20e3);

    genMainImgShadowQueue.on(handler);
    mainApp.win.webContents.send(routerConfig.on.genMainImgShadow, {
      id: this.id,
      material: this.material,
      options: config.options,
    });

    return p;
  }

  /**
   * @param height - 指定内容高度，默认为创建时的输入的图片高度
   */
  clacBgImgSize(height: number = this.sizeInfo.h) {
    if (!this.isInit) throw NotInit;

    let resetHeight = this.sizeInfo.resetH;
    let resetWidth = this.sizeInfo.resetW;

    const whRate = resetWidth / resetHeight;

    // 按照重置后的宽高比算出适合内容高度的宽度
    if (height) {
      resetHeight = height;
      resetWidth = Math.ceil(resetHeight * whRate);
    }
    else {
      // 主图高度比重置后的高度高，需要使用主图高度作为最终高度
      const validHeight = this.sizeInfo.h > resetHeight ? this.sizeInfo.h : resetHeight;
      resetHeight = validHeight;
      resetWidth = Math.ceil(resetHeight * whRate);
    }

    // 如果重置后，宽度太窄，则等比扩大宽高
    const mainImgWidthRate = (this.outputOpt.main_img_w_rate || 90) / 100;
    if (this.sizeInfo.w / resetWidth > mainImgWidthRate) {
      resetWidth = Math.ceil(this.sizeInfo.w / mainImgWidthRate);
      resetHeight = Math.ceil(resetWidth / whRate);
    }

    this.material.bg = {
      path: this.outputFileNames.bg,
      h: resetHeight,
      w: resetWidth,
      top: 0,
      left: 0,
    };
  }

  calcContentHeight() {
    const opt = this.outputOpt;
    const bgHeight = this.material.bg.h;
    const mainImgTopOffset = bgHeight * (opt.mini_top_bottom_margin / 100);
    const textButtomOffset = bgHeight * 0.027;

    // 主图上下间隔最小间隔
    let contentTop = Math.ceil(mainImgTopOffset);
    let mainImgOffset = contentTop * 2;

    // 阴影宽度
    if (opt.shadow_show) {
      const shadowHeight = Math.ceil(this.material.main[0].h * ((opt.shadow || 0) / 100));
      contentTop = Math.max(contentTop, Math.ceil(shadowHeight));
      mainImgOffset = contentTop * 2;
    }

    // 有文字时文字与主图的间隔要小于主图对顶部的间隔，并且底部间隔使用文字对底部的间隔
    if (this.material.text.length) {
      mainImgOffset *= 3 / 4;
      mainImgOffset += textButtomOffset;
    }

    // 文本高度
    const textH = this.material.text.reduce((n, i) => {
      n += i.h;
      return n;
    }, 0);

    // 生成背景图片
    const contentH = Math.ceil(textH + this.material.main[0].h + mainImgOffset);

    this.material.main[0].top = contentTop;
    this.contentH = contentH;

    if (this.material.text?.length) {
      this.material.text[this.material.text.length - 1].h += textButtomOffset;
    }
  }

  emit<U extends keyof EventMap>(
    event: U,
    ...args: Parameters<EventMap[U]>
  ): boolean {
    return super.emit(event, ...args);
  }

  off<U extends keyof EventMap>(
    eventName: U,
    listener: EventMap[U],
  ): this {
    super.off(eventName, listener);
    return this;
  }

  on<U extends keyof EventMap>(
    event: U,
    listener: EventMap[U],
  ): this {
    super.on(event, listener);
    return this;
  }

  once<U extends keyof EventMap>(
    event: U,
    listener: EventMap[U],
  ): this {
    super.once(event, listener);
    return this;
  }
}
