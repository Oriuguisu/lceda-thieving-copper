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
	// 按当前 extension.json 的版本精确定位，避免 build/dist 里堆积的旧包干扰检查。
	const extension = JSON.parse(fs.readFileSync(path.join(root, 'extension.json'), 'utf8'));
	const eext = `${extension.name}_v${extension.version}.eext`;
	if (!fs.existsSync(path.join(root, 'build/dist', eext))) {
		throw new Error(`build/dist 下没有找到 ${eext}，请先运行 npm run build`);
	}

	const zip = await JSZip.loadAsync(fs.readFileSync(path.join(root, 'build/dist', eext)));
	console.log(`package: ${eext}`);
	for (const [name, entry] of Object.entries(zip.files)) {
		if (!entry.dir) {
			console.log(`  ${name}  ${(await entry.async('string')).length} chars`);
		}
	}

	const manifest = JSON.parse(await zip.files['extension.json'].async('string'));
	const logoPath = manifest.images?.logo?.replace(/^\.\//, '');
	const logo = logoPath ? zip.files[logoPath] : undefined;
	if (!logo) {
		throw new Error(`扩展包里缺少 extension.json 指定的图标：${manifest.images?.logo ?? '(未声明)'}`);
	}
	const logoBytes = await logo.async('nodebuffer');
	// PNG 的 IHDR 紧跟 8 字节签名，宽高各 4 字节大端。
	const logoSize = { width: logoBytes.readUInt32BE(16), height: logoBytes.readUInt32BE(20) };
	console.log(`logo: ${logoPath} ${logoSize.width}x${logoSize.height} ${logoBytes.length} bytes`);
	if (logoSize.width < 200 || logoSize.height < 200 || logoSize.width !== logoSize.height) {
		throw new Error('扩展广场要求图标为 1:1 且不小于 200×200。');
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
