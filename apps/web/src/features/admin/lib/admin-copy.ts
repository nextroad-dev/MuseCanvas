/** No fallback to a record ID: only the explicitly supplied full value is copied. */
export async function copyAdminValue(value: string | undefined, clipboard?: Pick<Clipboard, 'writeText'>) {
  if (!value) throw new Error('没有可复制的明文')
  if (!clipboard) throw new Error('剪贴板不可用')
  await clipboard.writeText(value)
}
