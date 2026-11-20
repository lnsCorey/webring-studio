import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

/**
 * Vitest global setup. Image decoding runs in a worker thread (electron/services/imageWorker.ts),
 * and a worker needs a JavaScript file, but tests run the TypeScript sources. This compiles the
 * worker and the pipeline it uses into node_modules/.cache, where WEBRING_IMAGE_WORKER (set in
 * vite.config.mts) points, so every test decodes through a real worker. Their dependencies
 * (jpeg-js, pngjs) resolve from the project's node_modules.
 */
export const IMAGE_WORKER_TEST_DIR = path.resolve(__dirname, '../../node_modules/.cache/webring-image-worker');

export default function setup(): void {
  fs.mkdirSync(IMAGE_WORKER_TEST_DIR, { recursive: true });
  for (const name of ['imageWorker', 'imagePipeline']) {
    const source = fs.readFileSync(path.resolve(__dirname, `../../electron/services/${name}.ts`), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: `${name}.ts`,
    });
    fs.writeFileSync(path.join(IMAGE_WORKER_TEST_DIR, `${name}.js`), outputText);
  }
}
