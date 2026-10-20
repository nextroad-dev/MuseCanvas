/**
 * Landing-page copy that repeats as a list. Section-only copy (platform strip,
 * prompt card, footer) lives beside the markup that renders it.
 */

export const CAPABILITY_ITEMS: { title: string; description: string }[] = [
  {
    title: '用大白话描述画面',
    description: '写清主体、场景和光线就行，不用套模板，也不用学专门的写法。',
  },
  {
    title: '随时换模型和画面比例',
    description: '在同一个页面里切换模型、画面比例和张数，换完马上能用。',
  },
  {
    title: '失败自动重试，也能取消',
    description: '任务排队依次生成，失败会自动再试；不想要了可以随时取消。',
  },
  {
    title: '作品自动存进图库',
    description: '画好的图自动保存，可以放大查看、下载原图，或批量删除。',
  },
  {
    title: '邮箱验证码登录',
    description: '输入邮箱、收验证码就能登录，也支持 GitHub 和 Google 账号。',
  },
  {
    title: '可以装在自己的服务器上',
    description: '按向导一步步完成安装；用户、模型和登录方式都在后台管理。',
  },
]

export const WORKFLOW_STEPS: { title: string; description: string }[] = [
  {
    title: '写下画面',
    description: '用文字写下想要的画面，也可以上传一张参考图。',
  },
  {
    title: '选好参数',
    description: '选择模型、画面比例和张数，点发送即可。',
  },
  {
    title: '拿到作品',
    description: '画好的图自动存进图库，可以放大、下载或删除。',
  },
]
