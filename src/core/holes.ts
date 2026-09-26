import type { Point } from './geometry';
import { ellipsePoints, oblongPoints, rectanglePoints, rotatePoint } from './geometry';

/**
 * 把焊盘的钻孔换算成轮廓点。
 *
 * @remarks 非金属化孔和长槽孔的开孔可能比铜环更大，只按焊盘外形避让会漏。
 */
export function padHoleRing(pad: IPCB_PrimitivePad): Array<Point> | undefined {
	const hole = pad.getState_Hole();
	if (!hole) {
		return undefined;
	}

	const diameter = Number(hole[1]);
	if (!Number.isFinite(diameter) || diameter <= 0) {
		return undefined;
	}

	const centre = {
		x: pad.getState_X() + pad.getState_HoleOffsetX(),
		y: pad.getState_Y() + pad.getState_HoleOffsetY(),
	};
	const type = String(hole[0]);
	const rotation = pad.getState_HoleRotation();

	if (type === 'SLOT' || type === 'RECT') {
		const length = Math.max(Number(hole[2]) || diameter, diameter);
		const points = type === 'SLOT'
			? oblongPoints(centre, length, diameter)
			: rectanglePoints(centre, length, diameter);
		return points.map(point => rotatePoint(point, centre, rotation));
	}

	return ellipsePoints(centre, diameter / 2, diameter / 2);
}
