# Thieving Copper

[简体中文](./README.md)

An EasyEDA Pro (JLCEDA Pro) extension that fills the empty areas of a PCB with thieving copper, balancing copper density across the board to improve etching and plating uniformity.

## Features

- 🧩 **Three block shapes** — square, circle or diamond, with adjustable size and pitch, in either an orthogonal grid or a staggered layout
- 🛡️ **Automatic avoidance** — tracks, arcs, polylines, pads, vias, drill holes, fills, copper pours, and copper-layer text and images are all kept clear by the configured clearance
- 🕳️ **Board outline and cutouts** — recognises the board outline, board cutouts (fills on the multi layer) and non-plated holes, all kept clear by the board-edge clearance
- 🎯 **Three placement ranges** — the whole board, a band along the board edge, or a given rectangle (which can be read from the current selection)
- 🧱 **Multiple layers at once** — top, bottom and any enabled inner layers, optionally assigned to a net
- 👀 **Preview only** — runs the full analysis without creating anything, so you can try parameters first
- 🧹 **Two ways to remove** — undo precisely from the generation record, or clean up unrecorded blocks by size
- 💾 **Settings are remembered** — the panel reopens with your last parameters

## Installation

1. Download `lceda-thieving-copper_vX.Y.Z.eext` from [Releases](https://github.com/Oriuguisu/lceda-thieving-copper/releases)
2. Open EasyEDA Pro and go to the extension manager
3. Install a local extension and load the downloaded `.eext` file
4. Open any PCB document; a "盗铜工具" (Thieving Copper) menu appears in the top menu bar

## Quick start

1. Open a PCB document and choose "盗铜工具" → "盗铜面板…" (Thieving Copper → Panel)
2. Tick the target copper layers and check the block size, pitch and the two clearances
3. Click "仅预览数量" (Preview only) first — it analyses without creating anything
4. Once the count looks right, click "生成盗铜" (Generate)
5. Run a DRC afterwards to double-check clearances

## Menu items

| Item | Description |
| --- | --- |
| **盗铜面板…** (Panel) | The full parameter UI, recommended |
| **快速盗铜（对话框）…** (Quick) | Collects the key parameters through system dialogs instead, fills the whole board |
| **删除本插件生成的盗铜…** (Remove) | Undoes from the generation record, never touches copper you drew yourself |
| **使用说明** (About) | Feature summary |

The panel has two remove buttons. "删除本插件记录的盗铜" undoes precisely from the generation record. "按尺寸删除全部盗铜" is for when the record is lost: it scans the ticked copper layers and deletes single-ring fills whose bounding box matches the block size, which means small fills of the same size that you drew yourself are included too. Both buttons need a second click within 6 seconds to confirm.

## Parameters

| Parameter | Meaning |
| --- | --- |
| Block size | Bounding size of one block: edge length for a square, diameter for a circle, diagonal for a diamond |
| Pitch | Centre-to-centre distance, must exceed the block size plus the clearance |
| Layout | Staggered gives more even copper density, an orthogonal grid looks tidier |
| Copper clearance | Minimum gap between thieving copper and existing copper |
| Board clearance | Minimum gap to the board outline, board cutouts and non-plated holes |
| Grid precision | Resolution of the empty-area raster; finer is more accurate but slower, large boards are downscaled automatically |
| Maximum count | Safety cap so a single run cannot flood the editor with primitives |

In rectangle mode you can select objects on the canvas and click "读取当前选中对象的外框" to fill in the coordinates. Coordinates are canvas coordinates in millimetres.

## How it works

1. Lines, arcs and polylines on the board outline layer are stitched into closed rings. The largest ring is the board outline; rings inside it are cutouts. Fills and polylines on the multi layer, plus non-plated holes, are treated as cutouts as well.
2. For each target copper layer, all existing copper is collected, expanded by the configured clearance and rasterised into a mask covering the whole board.
3. A candidate grid is laid out with its phase locked to the data origin, and only positions whose entire block falls on free pixels are kept — so re-running on the same board gives the same result.
4. The blocks are created as solid Fill primitives in batches.

## Building from source

```bash
npm install
npm run typecheck
npm run lint
npm run build
```

The extension package is written to `build/dist/lceda-thieving-copper_vX.Y.Z.eext`. `npm run verify` checks that the package contents and the key parts of the inline window are present, and `npm run debug` starts watch mode with hot push.

The whole `iframe/` directory is a build artefact: the panel source is `src/ui/index.html`, and the build inlines the bundled script into it to produce `iframe/index.html`. EasyEDA's inline window does not reliably fetch resources referenced by `<script src>`, which leaves the panel stuck in its initial state; both the external and the inline copy are kept, and the script guards itself with a global flag so it only initialises once.

## Read-only self-check

`src/tools/dryrun.ts` is a self-check entry point that is not packaged. It exercises board outline detection, obstacle collection and empty-space computation against a real PCB, independently re-verifies the clearance of every candidate position with analytic distance maths, and reports which optional APIs exist in the running EDA version.

```bash
npm run dryrun
```

The resulting `build/dryrun.js` can be executed directly as the body of `async function (eda) { ... }` (for example pasted into EDA's standalone script runner). It never creates any primitives.

## Notes

- Thieving copper is created as solid Fill primitives on the selected copper layers.
- Results depend on a closed board outline. If the outline has gaps, stitching fails with a message.
- The empty-area test is raster based, and anti-aliased edge pixels always count as unusable, so results err on the safe side. Still run a DRC afterwards.
- Arcs are sampled from their signed sweep angle. If avoidance around a particular curved track looks offset, increase the copper clearance a little.
- Odd-shaped pads whose outline cannot be resolved are skipped and reported.
- The canvas-update-calculation APIs only exist in EDA v4.2 and later. Earlier versions simply redraw while building — slower, same result.
- Removal relies on the generation record saved per document. Manually deleting some blocks does not prevent the rest from being removed.
- Creating thousands of primitives noticeably increases file size and editor load, so try a larger pitch first.

## Licence

This extension is released under the [Apache License 2.0](https://choosealicense.com/licenses/apache-2.0/).
