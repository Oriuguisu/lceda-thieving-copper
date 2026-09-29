# 更新日志 / Changelog

## v1.0.2

- README 增加功能演示图：示例板铺设盗铜前后的对比
- README 改为纯 Markdown，不再使用 HTML 标签
- 修复存储接口的调用方式，避免在不提供该接口的环境下同步抛错中断生成流程

---

- Added demo images to the README: the sample board before and after thieving
- Rewrote the README in plain Markdown, no HTML tags
- Fixed how the storage APIs are called so a missing API can no longer abort generation with a synchronous throw

## v1.0.1

- 增加扩展图标，满足扩展广场的上架要求
- 图标由 `npm run logo` 程序化生成，图形即功能：一条铜色走线与两侧按安全间距自动避开它的盗铜块

---

- Added the extension logo required by the extension plaza
- The logo is generated programmatically via `npm run logo`; the artwork itself shows what the extension does: a copper track with thieving blocks keeping clear of it

## v1.0.0

首个发布版本 / First release.

### 功能 / Features

- 在 PCB 空旷区域自动铺设盗铜，支持正方形、圆形、菱形，可选正交网格或交错排列
- 按目标铜层收集走线、圆弧、折线、焊盘、过孔、钻孔、填充、铺铜、禁布区与铜层文字图片，按安全间距整体避让
- 识别板框轮廓、板内挖槽（多层填充）与非金属化孔，按板边间距避让
- 三种铺设范围：整板空白区、板边环形带、指定矩形区域
- 可同时处理多个铜层，可指定网络
- 「仅预览数量」只做分析不创建图元
- 两种删除方式：按生成记录撤销，或按尺寸清理无记录的盗铜
- 参数记忆，面板下次打开沿用

---

- Fills the empty areas of a PCB with thieving copper as squares, circles or diamonds, in an orthogonal grid or a staggered layout
- Collects tracks, arcs, polylines, pads, vias, drill holes, fills, copper pours, keepout regions and copper-layer text/images per target layer, and keeps them all clear by the configured clearance
- Recognises the board outline, board cutouts (fills on the multi layer) and non-plated holes, kept clear by the board-edge clearance
- Three placement ranges: whole board, board-edge band, or a given rectangle
- Handles several copper layers in one run, optionally assigned to a net
- "Preview only" analyses without creating any primitives
- Two removal modes: undo from the generation record, or clean up unrecorded blocks by size
- Panel settings are remembered between sessions
