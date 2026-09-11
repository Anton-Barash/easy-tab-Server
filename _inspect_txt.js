const fs = require('fs');
const file = 'c:/Users/Valeryk/AppData/Roaming/Trae CN/User/workspaceStorage/d56bc79d2e16a35b3474a55b6762dc8b/long-text/6aa21a66c8de071b60ffad00/mtx7smf8-4uc9/{_success_....txt';
const t = fs.readFileSync(file, 'utf8');
console.log('bytes:', t.length);
const s = t.replace(/^\uFEFF/, '').trim();
console.log('HEAD400:', JSON.stringify(s.slice(0, 400)));
console.log('TAIL200:', JSON.stringify(s.slice(-200)));
// Попробуем распарсить и показать верхний уровень.
try {
  const o = JSON.parse(s);
  const flat = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v && typeof v === 'object') flat[k] = `<${Array.isArray(v) ? 'array' : 'object'}>`;
    else flat[k] = v;
  }
  console.log('TOP:', JSON.stringify(flat, null, 2));
} catch (e) {
  console.log('PARSE_ERR:', e.message);
}