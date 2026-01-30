import { ExifTool } from '@modules/exiftool';
import { ImageTool } from '@modules/image-tool';
import { Router } from '@modules/router';
import routerConfig from '@root/router-config';
import { mainApp } from '@src/common/app';
import { genMainImgShadowQueue, genTextImgQueue, imageToolQueue } from '@src/common/queue';
import { config } from '@src/config';
import { cpObj } from '@utils';
import fs from 'node:fs';

const r = new Router();

interface StartTaskData {
    path: string
    name: string
}

interface ImgInfo {
  id: string
  path: string
  name: string
}

r.listen<StartTaskData[], ImgInfo[]>(routerConfig.addTask, async (fileUrlList) => {
  const imgList: ImgInfo[] = [];

  for (const fileInfo of fileUrlList) {
    const tool = new ImageTool(fileInfo.path, fileInfo.name, {
      cachePath: config.cacheDir,
      outputOption: cpObj(config.options),
      outputPath: cpObj(config.output),
    });

    tool.on('progress', (id, progress) => {
      mainApp.win.webContents.send(routerConfig.on.progress, { id, progress });
    });
    imgList.push({ id: tool.id, ...fileInfo });
    imageToolQueue.add(tool);
  }

  return imgList;
});

r.listen<void, boolean>(routerConfig.startTask, async () => {
  imageToolQueue.run();
  return true;
});

r.listen<{ path: string, name: string, maxSize?: number }, string>(routerConfig.preview, async (data) => {
  if (!data?.path) {
    throw new Error('preview: path is required');
  }

  const tool = new ImageTool(data.path, `__preview__${Date.now()}_${Math.random()}.jpg`, {
    cachePath: config.cacheDir,
    // 使用当前配置（实时预览跟随当前配置）
    outputOption: cpObj(config.options),
    // 预览不应该写入输出目录，兜底写到缓存目录
    outputPath: config.cacheDir,
  });

  const buf = await tool.genPreview({ maxSize: data.maxSize || 1100, quality: 80 });
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
});

r.listen(routerConfig.drainQueue, async () => imageToolQueue.drain());

r.listen(routerConfig.genTextImg, async (data: any) => genTextImgQueue.add(data));

r.listen(routerConfig.genMainImgShadow, async (data: any) => genMainImgShadowQueue.add(data));

r.listen<string>(routerConfig.getExitInfo, async (imgPath) => {
  if (!imgPath || typeof imgPath !== 'string' || !fs.existsSync(imgPath)) {
    return null;
  }
  try {
    const tool = new ExifTool(imgPath);
    return tool.parse();
  } catch {
    return null;
  }
});

export default r;
