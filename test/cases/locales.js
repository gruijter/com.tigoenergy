'use strict';

/*
Every translation object in the compose files has all 13 languages, and every locale file has the
same keys as en.json.
*/

const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', '..');
const LANGS = ['en', 'nl', 'de', 'fr', 'es', 'it', 'da', 'sv', 'no', 'pl', 'ru', 'ar', 'ko'];

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walk(full);
  return entry.name.endsWith('.json') ? [full] : [];
});

const keysOf = (value, prefix = '') => (value && typeof value === 'object'
  ? Object.entries(value).flatMap(([k, v]) => keysOf(v, prefix ? `${prefix}.${k}` : k))
  : [prefix]);

module.exports = async (t) => {
  const files = [
    ...walk(path.join(APP, '.homeycompose')),
    ...walk(path.join(APP, 'drivers')).filter((f) => /driver(\.settings)?\.compose\.json$/.test(f)),
  ];
  let objects = 0;
  const check = (value, where) => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => check(v, `${where}[${i}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (typeof value.en === 'string' && Object.values(value).every((v) => typeof v === 'string')) {
      objects += 1;
      const missing = LANGS.filter((lang) => typeof value[lang] !== 'string');
      t.ok(!missing.length, `${where} has all 13 languages${missing.length ? ` (missing ${missing.join(', ')})` : ''}`);
      return;
    }
    Object.entries(value).forEach(([k, v]) => check(v, `${where}.${k}`));
  };
  files.forEach((file) => check(JSON.parse(fs.readFileSync(file, 'utf8')), path.relative(APP, file)));
  t.ok(objects > 0, `found ${objects} translation objects`);

  const en = keysOf(JSON.parse(fs.readFileSync(path.join(APP, 'locales', 'en.json'), 'utf8'))).sort().join();
  for (const lang of LANGS) {
    const keys = keysOf(JSON.parse(fs.readFileSync(path.join(APP, 'locales', `${lang}.json`), 'utf8'))).sort().join();
    t.eq(keys, en, `locales/${lang}.json has the keys of en.json`);
  }
  for (const lang of LANGS.filter((l) => l !== 'en')) {
    t.ok(fs.existsSync(path.join(APP, `README.${lang}.txt`)), `README.${lang}.txt exists`);
  }
};
