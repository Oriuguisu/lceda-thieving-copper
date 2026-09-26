import type { ThievingPattern, ThievingSettings, ThievingShape } from './core/settings';
import { loadSettings, normalizeSettings, saveSettings } from './core/settings';
import { generateThieving, listCopperLayers } from './core/thieving';

type ValueCallback<T> = (value: T) => Promise<void> | void;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function showError(error: unknown, title = '盗铜失败'): void {
	eda.sys_Dialog.showInformationMessage(errorMessage(error), title, '确定');
}

export function showToast(
	message: string,
	type: 'error' | 'info' | 'success' | 'warn' = 'info',
	timer = 6,
): void {
	eda.sys_Message.showToastMessage(message, type as ESYS_ToastMessageType, timer);
}

function runCallback<T>(callback: ValueCallback<T>, value: T): void {
	void Promise.resolve()
		.then(() => callback(value))
		.catch(error => showError(error));
}

function parseNumberList(value: unknown, count: number): Array<number> {
	const values = String(value)
		.trim()
		.split(/[\s,，;；]+/)
		.filter(Boolean)
		.map(Number);

	if (values.length !== count || values.some(item => !Number.isFinite(item))) {
		throw new Error(`请输入 ${count} 个有效数字，并用逗号分隔。`);
	}
	return values;
}

function chooseLayers(settings: ThievingSettings, callback: ValueCallback<Array<number>>): void {
	void listCopperLayers().then((layers) => {
		if (layers.length === 0) {
			showError(new Error('没有读到可用的铜层，请确认当前是 PCB 文档。'), '无法铺设盗铜');
			return;
		}

		const options = layers.map(layer => ({
			value: String(layer.id),
			displayContent: layer.name,
		}));
		const preset = settings.layers.map(String).filter(id => options.some(item => item.value === id));

		eda.sys_Dialog.showSelectDialog(
			options,
			'选择要铺设盗铜的铜层：',
			'可以多选，每一层都会单独分析空白区域。',
			'目标铜层',
			preset.length > 0 ? preset : [options[0].value],
			true,
			(value) => {
				const selected = (Array.isArray(value) ? value : [value]).map(Number);
				if (selected.length === 0) {
					showError(new Error('请至少选择一个铜层。'), '参数无效');
					return;
				}
				runCallback(callback, selected);
			},
		);
	});
}

function promptSizes(
	settings: ThievingSettings,
	callback: ValueCallback<Array<number>>,
): void {
	const preset = [
		settings.blockSizeMm,
		settings.pitchMm,
		settings.clearanceMm,
		settings.boardClearanceMm,
	].join(', ');

	eda.sys_Dialog.showInputDialog(
		'依次输入：铜块尺寸(mm), 中心间距(mm), 与铜箔间距(mm), 与板边间距(mm)',
		'中心间距必须大于铜块尺寸加安全间距。示例：1, 2, 0.5, 1',
		'盗铜尺寸与间距',
		'text',
		preset,
		{ placeholder: '1, 2, 0.5, 1' },
		(value) => {
			try {
				runCallback(callback, parseNumberList(value, 4));
			}
			catch (error) {
				showError(error, '参数无效');
			}
		},
	);
}

function chooseStyle(
	settings: ThievingSettings,
	callback: ValueCallback<{ pattern: ThievingPattern; shape: ThievingShape }>,
): void {
	eda.sys_Dialog.showSelectDialog(
		[
			{ value: 'square:staggered', displayContent: '正方形 · 交错排列（推荐）' },
			{ value: 'square:grid', displayContent: '正方形 · 正交网格' },
			{ value: 'circle:staggered', displayContent: '圆形 · 交错排列' },
			{ value: 'circle:grid', displayContent: '圆形 · 正交网格' },
			{ value: 'diamond:staggered', displayContent: '菱形 · 交错排列' },
			{ value: 'diamond:grid', displayContent: '菱形 · 正交网格' },
		],
		'选择盗铜的形状和排列方式：',
		'交错排列的铜密度更均匀，正交网格更整齐。',
		'盗铜样式',
		`${settings.shape}:${settings.pattern}`,
		false,
		(value) => {
			const [shape, pattern] = String(value).split(':');
			runCallback(callback, {
				shape: shape as ThievingShape,
				pattern: pattern as ThievingPattern,
			});
		},
	);
}

async function runGeneration(settings: ThievingSettings): Promise<void> {
	try {
		await saveSettings(settings);
		eda.sys_LoadingAndProgressBar.showProgressBar(0, '正在铺设盗铜');
		const outcome = await generateThieving(settings, (percent, message) => {
			eda.sys_LoadingAndProgressBar.showProgressBar(Math.min(99, Math.round(percent)), message);
		});
		eda.sys_LoadingAndProgressBar.destroyProgressBar();

		const total = outcome.outcomes.reduce((sum, item) => sum + item.created, 0);
		if (total === 0) {
			showToast('没有找到满足条件的空位，可尝试减小铜块尺寸或间距。', 'warn');
			return;
		}

		const detail = outcome.outcomes.map(item => `${item.layerName} ${item.created} 个`).join('，');
		showToast(`已生成 ${total} 个盗铜（${detail}）。建议运行 DRC 复核。`, 'success', 8);
		for (const warning of outcome.warnings) {
			showToast(warning, 'warn', 8);
		}
	}
	catch (error) {
		eda.sys_LoadingAndProgressBar.destroyProgressBar();
		showError(error);
	}
}

/**
 * 不依赖内联窗口的备用入口，逐步用系统对话框收集最关键的几个参数。
 */
export function startQuickThieving(): void {
	const settings = loadSettings();

	chooseLayers(settings, (layers) => {
		promptSizes(settings, ([blockSizeMm, pitchMm, clearanceMm, boardClearanceMm]) => {
			chooseStyle(settings, async (style) => {
				await runGeneration(normalizeSettings({
					...settings,
					layers,
					blockSizeMm,
					pitchMm,
					clearanceMm,
					boardClearanceMm,
					shape: style.shape,
					pattern: style.pattern,
					rangeMode: 'board',
					rectangleMm: undefined,
				}));
			});
		});
	});
}
