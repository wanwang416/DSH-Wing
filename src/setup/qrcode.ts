/**
 * /setup 扫码建应用 · 二维码渲染
 *
 * ASCII 二维码（qrcode 库 terminal 输出）用于飞书消息/终端展示；
 * PNG 二维码（toPngBuffer）用于 DSH Web 面板展示（/plugins/dsh-wing/qr route）。
 */
import QRCode from "qrcode";

/** 渲染 ASCII 二维码；失败返回空串（调用方降级为纯链接） */
export async function toAsciiQr(url: string): Promise<string> {
  try {
    return await QRCode.toString(url, { type: "terminal", small: true });
  } catch {
    return "";
  }
}

/** 渲染 PNG 二维码 buffer（Web 面板 img 直接引用）；失败返回 undefined */
export async function toPngBuffer(url: string): Promise<Buffer | undefined> {
  try {
    return await QRCode.toBuffer(url, { type: "png", margin: 1, width: 256 });
  } catch {
    return undefined;
  }
}

/** 授权链接过期提示（复用同一文案，避免散落） */
export function qrHint(expireIn: number): string {
  return `⚠️ 链接 ${expireIn} 秒后过期。用手机飞书扫码，或电脑浏览器打开链接完成授权。`;
}
