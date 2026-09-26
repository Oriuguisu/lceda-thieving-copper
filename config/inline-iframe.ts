import type esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(__dirname, '../src/ui/index.html');
const OUTPUT = path.join(__dirname, '../iframe/index.html');
const BUNDLE = path.join(__dirname, '../iframe/app.js');
const PLACEHOLDER = '<!-- INLINE_SCRIPT -->';

/**
 * 把内联窗口脚本直接写进 HTML。
 *
 * @remarks
 * EDA 只会读取 HTML 直接关联的资源，实测 `<script src>` 在内联窗口里可能取不到文件，
 * 面板会停在初始状态。因此同时保留外链和内联两份：谁能跑起来都行，脚本自身用
 * 全局标志位保证只初始化一次。
 */
export function inlineIframeScript(): esbuild.Plugin {
	return {
		name: 'inline-iframe-script',
		setup(build) {
			build.onEnd(async (result) => {
				if (result.errors.length > 0) {
					return;
				}

				const [template, bundle] = await Promise.all([
					fs.readFile(TEMPLATE, 'utf-8'),
					fs.readFile(BUNDLE, 'utf-8'),
				]);
				if (!template.includes(PLACEHOLDER)) {
					throw new Error(`内联窗口模板缺少占位符 ${PLACEHOLDER}`);
				}

				const inlined = template.replace(
					PLACEHOLDER,
					`<script>\n${bundle.replace(/<\/script>/gi, '<\\/script>')}\n</script>`,
				);
				await fs.outputFile(OUTPUT, inlined, 'utf-8');
			});
		},
	};
}
