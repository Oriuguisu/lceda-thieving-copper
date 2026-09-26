import extensionConfig from '../extension.json' with { type: 'json' };
import { invokeOptional } from './core/api';
import {
	PANEL_HEIGHT,
	PANEL_HTML_PATH,
	PANEL_IFRAME_ID,
	PANEL_WIDTH,
} from './core/panel';
import {
	countRecordedBlocks,
	removeThievingBlocks,
	requirePcbDocumentUuid,
} from './core/thieving';
import { showError, showToast, startQuickThieving } from './dialogs';

export function activate(): void {}

async function startPanel(): Promise<void> {
	try {
		await requirePcbDocumentUuid();
		const exists = await invokeOptional<boolean>(
			eda.sys_IFrame,
			'isIFrameAlreadyExist',
			PANEL_IFRAME_ID,
		);
		if (exists && await invokeOptional<boolean>(eda.sys_IFrame, 'showIFrame', PANEL_IFRAME_ID)) {
			return;
		}

		const opened = await invokeOptional<boolean>(
			eda.sys_IFrame,
			'openIFrame',
			PANEL_HTML_PATH,
			PANEL_WIDTH,
			PANEL_HEIGHT,
			PANEL_IFRAME_ID,
			{ title: '盗铜工具', minimizeButton: true },
		);
		if (opened === undefined) {
			throw new Error('当前 EDA 版本不支持内联窗口，请改用菜单里的「快速盗铜（对话框）」。');
		}
	}
	catch (error) {
		showError(error, '无法打开盗铜面板');
	}
}

async function startRemove(): Promise<void> {
	try {
		const documentUuid = await requirePcbDocumentUuid();
		const count = countRecordedBlocks(documentUuid);
		if (count === 0) {
			showToast('当前文档没有本插件生成的盗铜记录。', 'info');
			return;
		}

		eda.sys_Dialog.showConfirmationMessage(
			`将删除本插件在当前文档生成的 ${count} 个盗铜，是否继续？`,
			'删除盗铜',
			'删除',
			'取消',
			(confirmed) => {
				if (!confirmed) {
					return;
				}
				void removeThievingBlocks(documentUuid)
					.then(removed => showToast(`已删除 ${removed} 个盗铜。`, 'success'))
					.catch(error => showError(error, '删除失败'));
			},
		);
	}
	catch (error) {
		showError(error, '删除失败');
	}
}

export function openThievingPanel(): void {
	void startPanel();
}

export function quickThieving(): void {
	try {
		startQuickThieving();
	}
	catch (error) {
		showError(error);
	}
}

export function removeThieving(): void {
	void startRemove();
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		[
			`盗铜工具 v${extensionConfig.version}`,
			'',
			'在 PCB 空旷区域自动铺设盗铜铜块，用于平衡各区域铜密度、改善蚀刻与电镀均匀性。',
			'',
			'盗铜面板：可选目标铜层、形状、尺寸、间距、排列方式与铺设范围，参数会被记住。',
			'快速盗铜：不打开面板，用系统对话框依次填写最关键的几个参数，整板铺设。',
			'删除盗铜：按本插件的生成记录一键撤销，不会动到你自己画的铜。',
			'',
			'铺设前会读取板框轮廓，并按目标层收集走线、圆弧、焊盘、过孔、填充、铺铜、',
			'禁布区与铜层文字，按设定的安全间距整体避让。',
			'',
			'注意：结果依赖板框闭合且间距参数合理，生成后请运行一次 DRC 复核。',
		].join('\n'),
		'盗铜工具',
		'确定',
	);
}
