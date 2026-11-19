import { AGENT_MESSAGE_MAX_ATTACHMENTS, type AgentMessageAttachment } from '@musecanvas/contracts'
import type { ReferenceImageAttachment } from '../stores/agent-console-store'

export function countAgentMessageAttachmentReferences(
  attachments: readonly ReferenceImageAttachment[],
): number {
  return attachments.reduce((count, attachment) => count + (attachment.preparation ? 2 : 1), 0)
}

export function validateAgentMessageAttachmentCount(
  attachments: readonly ReferenceImageAttachment[],
): void {
  const count = countAgentMessageAttachmentReferences(attachments)
  if (count > AGENT_MESSAGE_MAX_ATTACHMENTS) {
    throw new Error(
      `消息最多允许 ${AGENT_MESSAGE_MAX_ATTACHMENTS} 个附件引用（当前 ${count} 个）；局部修改会占用 2 个，请减少参考图后重试。`,
    )
  }
}

function attachmentMimeType(attachment: ReferenceImageAttachment): 'image/png' | 'image/jpeg' {
  if (attachment.mimeType !== 'image/png' && attachment.mimeType !== 'image/jpeg') {
    throw new Error(`参考图「${attachment.name}」格式不支持，仅支持 PNG 或 JPEG 图片。`)
  }
  return attachment.mimeType
}

/**
 * 草稿附件 → 服务端消息附件。
 *
 * 这里只做**形状**转换：把一条已准备的「局部修改」草稿展开成服务端要求的一对引用
 * （`reference_image` + 带 `preparationVersion/sourceChecksum` 的 `mask`），把普通
 * 参考图收敛成 `asset`/`upload` 之一。归属、checksum、蒙版准备身份与有效期全部由
 * 服务端在受理时和付费事务里各验一次，前端不伪造也不需要伪造。
 *
 * 任何缺字段、过期或非法组合都在这里**抛错**：静默丢一张参考图会让模型看到一个
 * 和用户意图不同的请求。
 */
export function toAgentMessageAttachments(
  attachments: readonly ReferenceImageAttachment[],
  now: number = Date.now(),
): AgentMessageAttachment[] {
  validateAgentMessageAttachmentCount(attachments)
  const result: AgentMessageAttachment[] = []
  for (const attachment of attachments) {
    const width = attachment.width ?? 0
    const height = attachment.height ?? 0
    if (attachment.preparation) {
      const { maskUploadId } = attachment.preparation
      if (!maskUploadId) throw new Error('局部修改遮罩缺少上传标识，请重新框选。')
      const expiresAt = Date.parse(attachment.preparation.expiresAt)
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        throw new Error(`局部修改准备已过期，请重新框选「${attachment.name}」的修改区域。`)
      }
      if (width < 1 || height < 1) throw new Error('局部修改缺少图片尺寸，请重新选择图库图片。')
      result.push({
        kind: 'upload',
        id: maskUploadId,
        role: 'mask',
        checksum: attachment.preparation.maskChecksum,
        width,
        height,
        mimeType: 'image/png',
        preparationVersion: 1,
        sourceChecksum: attachment.preparation.sourceChecksum,
      })
      // 源图与被准备的蒙版必须成对出现：蒙版身份绑定的是源图 checksum，缺了源图
      // 服务端会拒绝，而在这里就把错误指回具体那张图更清楚。
      result.push({
        kind: attachment.preparation.sourceKind,
        id: attachment.preparation.sourceId,
        role: 'reference_image',
        checksum: attachment.preparation.sourceChecksum,
        width,
        height,
        mimeType: attachmentMimeType(attachment),
      })
      continue
    }
    const canUseStoredAsset =
      (attachment.source === 'library' || attachment.source === 'artifact') && Boolean(attachment.assetId)
    const kind = canUseStoredAsset
      ? 'asset'
      : attachment.source === 'upload' && attachment.uploadId ? 'upload' : null
    if (!kind) throw new Error(`参考图「${attachment.name}」尚未完成上传或不是可复用的图库资产，请移除后重新上传。`)
    if (!attachment.checksum) {
      throw new Error(`参考图「${attachment.name}」缺少服务端校验信息，当前图库接口未返回该字段；请先在本地上传这张图片后再引用。`)
    }
    if (width < 1 || height < 1) throw new Error(`参考图「${attachment.name}」缺少可用尺寸，请重新选择。`)
    result.push({
      kind,
      id: kind === 'asset' ? attachment.assetId! : attachment.uploadId!,
      role: 'reference_image',
      checksum: attachment.checksum,
      width,
      height,
      mimeType: attachmentMimeType(attachment),
    })
  }
  return result
}
