import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(__dirname, 'dryrun.js');

/**
 * 打包只读自检脚本。产物可直接作为 `async function (eda) { ... }` 的函数体执行，
 * 例如通过 EDA 的独立脚本或外部桥接工具运行，用来在真实 PCB 上验证算法而不改动设计。
 */
esbuild
	.build({
		entryPoints: [path.join(__dirname, '../src/tools/dryrun.ts')],
		outfile: OUTPUT,
		bundle: true,
		format: 'iife',
		globalName: 'thievingDryRun',
		platform: 'browser',
		treeShaking: true,
		footer: { js: '\nreturn await thievingDryRun.dryRun();\n' },
	})
	.then(() => {
		console.log(`Dry-run script ready: ${OUTPUT}`);
	})
	.catch((error) => {
		console.error('Dry-run build failed:', error);
		process.exit(1);
	});
