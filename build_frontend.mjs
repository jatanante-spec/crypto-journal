/* Static-site build for the Journal frontend.
   Assembles the Apps Script sources into one static page that any static host
   (Cloudflare Pages, GitHub Pages, Netlify, Vercel) can serve as text/html.
   No dependencies: node build_frontend.mjs  ->  dist/index.html  */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFile(path.join(root, file), 'utf8');

const [index, styles, javascript, runtime] = await Promise.all([
  read('apps-script/Index.html'),
  read('apps-script/Styles.html'),
  read('apps-script/JavaScript.html'),
  read('dev/supabase_runtime.js')
]);

const stylesMarker = "<?!= include('Styles'); ?>";
const javascriptMarker = "<?!= include('JavaScript'); ?>";
if (!index.includes(stylesMarker) || !index.includes(javascriptMarker)) {
  throw new Error('apps-script/Index.html does not contain the expected Apps Script include markers.');
}

const output = index
  .replace(stylesMarker, styles)
  .replace(javascriptMarker, `<script>\n${runtime}\n</script>\n${javascript}`);

const outDir = path.join(root, 'dist');
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'index.html'), output, 'utf8');
console.log(`Static build written to ${path.join(outDir, 'index.html')} (${output.length} bytes)`);
