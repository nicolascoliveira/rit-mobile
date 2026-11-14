import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const backend = process.env.API_TARGET || 'http://127.0.0.1:3000';
const apiOrigin = process.env.API_ORIGIN || 'http://localhost:8080';

const catalogueMedia = {
  name: 'rit-portal-catalogue-media',
  configureServer(server) {
    const dirs = { '/exercise-media/still/': ['still', '.webp'], '/exercise-media/clip/': ['clip', '.mp4'] };
    const root = resolve(__dirname, '../catalogue/media');
    server.middlewares.use((req, res, next) => {
      const prefix = Object.keys(dirs).find(p => (req.url || '').startsWith(p));
      if (!prefix) return next();
      const [dir, ext] = dirs[prefix];
      const name = decodeURIComponent(req.url.slice(prefix.length).split('?')[0]);
      const file = join(root, dir, name);
      if (!/^\d{4,5}\.(webp|mp4)$/.test(name) || !name.endsWith(ext) || !existsSync(file)) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader('Content-Type', ext === '.mp4' ? 'video/mp4' : 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.end(readFileSync(file));
    });
  }
};

const localLeanQr = resolve(__dirname, 'node_modules/lean-qr/index.mjs');
const fallbackLeanQr = resolve(__dirname, '../frontend/node_modules/lean-qr/index.mjs');

export default defineConfig({
  root: __dirname,
  plugins: [react(), catalogueMedia],
  resolve: {
    alias: {
      'lean-qr': existsSync(localLeanQr) ? localLeanQr : fallbackLeanQr
    }
  },
  server: {
    port: 8081,
    host: true,
    fs: { allow: ['..'] },
    proxy: {
      '/api': {
        target: backend,
        changeOrigin: true,
        headers: { Origin: apiOrigin }
      }
    }
  }
});
