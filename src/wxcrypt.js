// 企业微信回调消息加解密（WXBizMsgCrypt 的最小实现）
import crypto from 'node:crypto';

export function getSignature(token, timestamp, nonce, encrypt) {
  return crypto
    .createHash('sha1')
    .update([token, timestamp, nonce, encrypt].sort().join(''))
    .digest('hex');
}

export function decrypt(encodingAESKey, encrypted) {
  const key = Buffer.from(encodingAESKey + '=', 'base64');
  if (key.length !== 32) throw new Error('EncodingAESKey 无效（应为 43 位）');
  const iv = key.subarray(0, 16);
  const de = crypto.createDecipheriv('aes-256-cbc', key, iv);
  de.setAutoPadding(false);
  let buf = Buffer.concat([de.update(encrypted, 'base64'), de.final()]);
  const pad = buf[buf.length - 1];
  buf = buf.subarray(0, buf.length - pad);
  // 结构：16B 随机串 + 4B 消息长度 + 消息体 + receiveId(corpid)
  const len = buf.readUInt32BE(16);
  return {
    msg: buf.subarray(20, 20 + len).toString('utf8'),
    receiveId: buf.subarray(20 + len).toString('utf8'),
  };
}
