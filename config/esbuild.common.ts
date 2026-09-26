import type esbuild from 'esbuild';
import { inlineIframeScript } from './inline-iframe.ts';

type BuildOptions = Parameters<(typeof esbuild)['build']>[0];

const shared = {
	entryNames: '[name]',
	assetNames: '[name]',
	bundle: true, // 用于内部方法调用，请勿修改
	minify: false, // 用于内部方法调用，请勿修改
	loader: {},
	sourcemap: undefined,
	platform: 'browser', // 用于内部方法调用，请勿修改
	format: 'iife', // 用于内部方法调用，请勿修改
	globalName: 'edaEsbuildExportName', // 用于内部方法调用，请勿修改
	treeShaking: true,
	ignoreAnnotations: true,
	define: {},
	external: [],
} satisfies BuildOptions;

/** 扩展主体，由 extension.json 的 entry 字段加载。 */
export const extensionBuildOptions = {
	...shared,
	entryPoints: {
		index: './src/index',
	},
	outdir: './dist/',
} satisfies BuildOptions;

/** 内联窗口脚本，构建后会同时内联进 iframe/index.html。 */
export const iframeBuildOptions = {
	...shared,
	entryPoints: {
		app: './src/ui/main',
	},
	outdir: './iframe/',
	plugins: [inlineIframeScript()],
} satisfies BuildOptions;

export const allBuildOptions: Array<BuildOptions> = [extensionBuildOptions, iframeBuildOptions];

export default extensionBuildOptions;
