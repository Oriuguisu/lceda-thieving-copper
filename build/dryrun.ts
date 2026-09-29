import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 打包自检脚本。产物可直接作为 `async function (eda) { ... }` 的函数体执行，
 * 例如通过 EDA 的独立脚本或外部桥接工具运行。
 *
 * - `dryrun.js` 只做分析，不改动设计，用来在真实 PCB 上验证算法。
 * - `demo-run.js` 会真实创建图元，只用于在演示板上制作截图素材。
 */
const TARGETS = [
	{ file: 'dryrun.js', call: 'dryRun' },
	{ file: 'demo-run.js', call: 'generateForDemo' },
];

Promise.all(TARGETS.map(target => esbuild.build({
	entryPoints: [path.join(__dirname, '../src/tools/dryrun.ts')],
	outfile: path.join(__dirname, target.file),
	bundle: true,
	format: 'iife',
	globalName: 'thievingDryRun',
	platform: 'browser',
	treeShaking: true,
	footer: { js: `\nreturn await thievingDryRun.${target.call}();\n` },
})))
	.then(() => {
		console.log(`Scripts ready: ${TARGETS.map(target => target.file).join(', ')}`);
	})
	.catch((error) => {
		console.error('Dry-run build failed:', error);
		process.exit(1);
	});
