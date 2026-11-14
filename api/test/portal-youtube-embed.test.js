import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractYouTubeId } from '../../portal/src/lib/media-upload.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('portal extractYouTubeId parses supported URLs including schemeless links and rejects invalid ones', () => {
  assert.equal(extractYouTubeId('https://www.youtube.com/watch?v=99QhMQoxmOk'), '99QhMQoxmOk');
  assert.equal(extractYouTubeId('https://youtu.be/99QhMQoxmOk?si=test'), '99QhMQoxmOk');
  assert.equal(extractYouTubeId('https://www.youtube.com/shorts/99QhMQoxmOk'), '99QhMQoxmOk');
  assert.equal(extractYouTubeId('https://www.youtube.com/live/99QhMQoxmOk?feature=share'), '99QhMQoxmOk');
  assert.equal(extractYouTubeId('https://www.youtube-nocookie.com/embed/99QhMQoxmOk'), '99QhMQoxmOk');
  assert.equal(extractYouTubeId('youtube.com/watch?v=99QhMQoxmOk'), '99QhMQoxmOk');
  assert.equal(extractYouTubeId('youtu.be/99QhMQoxmOk'), '99QhMQoxmOk');

  assert.equal(extractYouTubeId(''), '');
  assert.equal(extractYouTubeId('https://vimeo.com/123456789'), '');
  assert.equal(extractYouTubeId('javascript:youtube.com/watch?v=99QhMQoxmOk'), '');
  assert.equal(extractYouTubeId('https://user:pass@youtube.com/watch?v=99QhMQoxmOk'), '');
  assert.equal(extractYouTubeId('https://youtube.com:8443/watch?v=99QhMQoxmOk'), '');
});

test('both Portal and Student YouTube iframes send strict-origin-when-cross-origin to prevent Error 153 under same-origin Referrer-Policy', () => {
  for (const file of [
    'portal/src/components/ExerciseMediaModal.jsx',
    'frontend/src/components/YouTubeVideo.jsx'
  ]) {
    const src = read(file);
    const iframeMatch = src.match(/<iframe[\s\S]*?\/>/);
    assert.ok(iframeMatch, `expected <iframe ... /> in ${file}`);
    assert.match(iframeMatch[0], /youtube-nocookie\.com\/embed\//, `${file} must use youtube-nocookie.com embed`);
    assert.match(
      iframeMatch[0],
      /referrerPolicy="strict-origin-when-cross-origin"/,
      `${file} must opt the YouTube iframe into referrerPolicy="strict-origin-when-cross-origin" so Error 153 does not trigger`
    );
  }

  const portalNginx = read('portal/nginx.conf.template');
  assert.match(portalNginx, /frame-src[^;]*https:\/\/www\.youtube-nocookie\.com/);
});

