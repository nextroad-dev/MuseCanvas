import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPromptOptimizationRepairUserPrompt, buildPromptOptimizationSchema, buildPromptOptimizationSystemPrompt, buildPromptOptimizationUserPrompt, buildTemplateSelectionSystemPrompt, buildTemplateSelectionUserPrompt, buildTemplateSelectorModelOptions, hasConsoleControlParams, parsePromptOptimizationOutput } from './index'

test('template selector prompt keeps the task narrow and non-reasoning friendly', () => {
  const system = buildTemplateSelectionSystemPrompt()
  const user = buildTemplateSelectionUserPrompt({ prompt: '做一张品牌海报', modelName: 'Seedream 4.5', templateChoices: '海报: 品牌海报\n产品图: 商品展示' })
  const options = buildTemplateSelectorModelOptions({ protocol: 'openai_responses', vendorModelId: 'gpt-5.5', maxOutputTokens: 25000 })

  assert.equal(system.includes('只返回模板名称'), true)
  assert.equal(system.includes('__NO_TEMPLATE__'), true)
  assert.equal(system.includes('不要解释'), true)
  assert.equal(user.includes('目标生图模型：Seedream 4.5'), true)
  assert.equal(user.includes('尺寸='), false)
  assert.equal(user.includes('质量='), false)
  assert.equal(user.includes('数量='), false)
  assert.deepEqual(options, { maxOutputTokens: 200, temperature: undefined, reasoningEffort: 'none' })
})

test('prompt optimizer prompt excludes console params from both instructions and user payload', () => {
  const system = buildPromptOptimizationSystemPrompt()
  const user = buildPromptOptimizationUserPrompt({ prompt: '生成一张极简风咖啡海报', renderedTemplate: '突出留白、标题层级和产品主体。' })
  const schema = buildPromptOptimizationSchema()

  assert.equal(system.includes('最终 JSON'), true)
  assert.equal(system.includes('不要写尺寸、具体比例、生成数量、质量档位、模型参数或控制台参数'), true)
  assert.equal(system.includes('只保留画面内容'), true)
  assert.equal(user.includes('模板要求：'), true)
  assert.equal(user.includes('尺寸='), false)
  assert.equal(user.includes('质量='), false)
  assert.equal(user.includes('数量='), false)
  assert.deepEqual(schema, {
    type: 'object',
    additionalProperties: false,
    properties: { title: { type: 'string' }, prompt: { type: 'string' } },
    required: ['title', 'prompt'],
  })
})

test('prompt optimizer fallback prompt works without a template', () => {
  const user = buildPromptOptimizationUserPrompt({ prompt: '一个温暖的绘本风卧室场景' })
  assert.equal(user.includes('没有合适模板'), true)
  assert.equal(user.includes('用户原始提示词：'), true)
})

test('prompt optimizer parses strict JSON output', () => {
  assert.deepEqual(parsePromptOptimizationOutput('{"title":"咖啡海报","prompt":"极简咖啡杯主体，温暖晨光，大片留白。"}'), { title: '咖啡海报', prompt: '极简咖啡杯主体，温暖晨光，大片留白。' })
  assert.deepEqual(parsePromptOptimizationOutput('```json\n{"title":"绘本卧室","prompt":"柔和绘本风卧室，暖色台灯，安静睡前氛围。"}\n```'), { title: '绘本卧室', prompt: '柔和绘本风卧室，暖色台灯，安静睡前氛围。' })
  assert.throws(() => parsePromptOptimizationOutput('标题：咖啡海报\n提示词：极简咖啡杯'), /PROMPT_OUTPUT_INVALID/)
  assert.throws(() => parsePromptOptimizationOutput('{"title":"ok","prompt":"ok","extra":true}'), /PROMPT_OUTPUT_INVALID/)
})

test('console param validation catches generated controls without blocking composition intent', () => {
  assert.equal(hasConsoleControlParams('竖版海报构图，人物居中，顶部保留标题空间。'), false)
  assert.equal(hasConsoleControlParams('宽银幕电影感构图，远景城市天际线。'), false)
  assert.equal(hasConsoleControlParams('极简咖啡海报，尺寸=1024x1024，质量 high。'), true)
  assert.equal(hasConsoleControlParams('复古旅行海报，宽高比 16:9，生成4张。'), true)
  assert.equal(hasConsoleControlParams('cinematic portrait --ar 9:16 --quality high'), true)
})

test('repair prompt asks for a second JSON pass when console params leak', () => {
  const user = buildPromptOptimizationRepairUserPrompt({ prompt: '竖版咖啡海报', renderedTemplate: '强调产品主体。', previousPrompt: '咖啡杯主体，尺寸=1024x1536。' })
  assert.equal(user.includes('重新输出 JSON'), true)
  assert.equal(user.includes('上一版最终提示词：'), true)
  assert.equal(user.includes('咖啡杯主体，尺寸=1024x1536。'), true)
})
