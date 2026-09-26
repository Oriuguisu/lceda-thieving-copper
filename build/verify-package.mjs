import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 检查打包结果：列出包内文件，并确认内联窗口的关键内容都在。
 */
async function main() {
	const [eext] = fs
		.readdirSync(path.join(root, 'build/dist'))
		.filter(name => name.endsWith('.eext'));
	if (!eext) {
		throw new Error('build/dist 下没有找到 .eext，请先运行 npm run build');
	}

	const zip = await JSZip.loadAsync(fs.readFileSync(path.join(root, 'build/dist', eext)));
	console.log(`package: ${eext}`);
	for (const [name, entry] of Object.entries(zip.files)) {
		if (!entry.dir) {
			console.log(`  ${name}  ${(await entry.async('string')).length} chars`);
		}
	}

	const html = await zip.files['iframe/index.html'].async('string');
	const checks = {
		inlineScript: /<script>[\s\S]*edaEsbuildExportName/.test(html),
		externalScript: html.includes('src="./app.js"'),
		startGuard: html.includes('__thievingCopperPanelStarted'),
		defaultClearance: html.includes('value="0.5"'),
		defaultPitch: html.includes('value="2"'),
		removeAllButton: html.includes('button-remove-all'),
		optionalApiGuard: html.includes('stopCanvasUpdateCalculation'),
	};
	console.log('checks:', checks);

	const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
	if (failed.length > 0) {
		throw new Error(`检查未通过：${failed.join(', ')}`);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
