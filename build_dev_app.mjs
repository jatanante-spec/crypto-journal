import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.join(root, 'apps-script');
const outputDir = path.join(root, 'dev-build');

const [index, styles, javascript, runtime] = await Promise.all([
  readFile(path.join(sourceDir, 'Index.html'), 'utf8'),
  readFile(path.join(sourceDir, 'Styles.html'), 'utf8'),
  readFile(path.join(sourceDir, 'JavaScript.html'), 'utf8'),
  readFile(path.join(root, 'dev', 'supabase_runtime.js'), 'utf8')
]);

const stylesMarker = "<?!= include('Styles'); ?>";
const javascriptMarker = "<?!= include('JavaScript'); ?>";

if (!index.includes(stylesMarker) || !index.includes(javascriptMarker)) {
  throw new Error('apps-script/Index.html does not contain the expected Apps Script include markers.');
}

const runtimeScript = `<script>\n${runtime}\n</script>`;
const output = index
  .replace(stylesMarker, () => styles)
  .replace(javascriptMarker, () => `${runtimeScript}\n${javascript}`);

await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, 'index.html'), output, 'utf8');
console.log(`Development build written to ${path.join(outputDir, 'index.html')}`);
