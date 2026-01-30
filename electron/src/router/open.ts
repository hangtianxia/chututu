import fs from 'node:fs';
import path from 'node:path';

import { config } from '@config';
import { Router } from '@modules/router';
import routerConfig from '@root/router-config';
import { dialog, shell } from 'electron';

const r = new Router();

r.listen(routerConfig.open.dir, async (data) => shell.openPath(data));

r.listen(routerConfig.open.selectPath, async (data, event, win) => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
  });

  if (!res.canceled && res.filePaths.length > 0) {
    config.output = res.filePaths[0];

    if (import.meta.env.DEV) {
      config.cacheDir = path.join(config.output, '.catch');

      if (!fs.existsSync(config.cacheDir)) {
        fs.mkdirSync(config.cacheDir, { recursive: true });
      }
    }

    fs.writeFileSync(config.dir, JSON.stringify(config, null, 0));
    return config;
  }

  return false;
});

// Pick a directory without mutating persisted config.
r.listen(routerConfig.open.pickDir, async (data, event, win) => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
  });

  if (!res.canceled && res.filePaths.length > 0) {
    return res.filePaths[0];
  }

  return false;
});

r.listen(routerConfig.saveAs, async (data: {
  defaultPath?: string
  filters?: { name: string, extensions: string[] }[]
  buf: Uint8Array | number[]
}, event, win) => {
  const res = await dialog.showSaveDialog(win, {
    defaultPath: data?.defaultPath,
    filters: data?.filters,
  });

  if (res.canceled || !res.filePath) {
    return false;
  }

  const buf = Buffer.isBuffer(data.buf)
    ? data.buf
    : Buffer.from(data.buf as any);

  fs.writeFileSync(res.filePath, buf);
  return res.filePath;
});

export default r;
