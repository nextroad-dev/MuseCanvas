export const modelPresets = [
  {
    id: 'openai-gpt-image-2', displayName: 'GPT Image 2', adapter: 'openai', vendorModelId: 'gpt-image-2', baseUrl: 'https://api.openai.com',
    sizes: ['1024x1024', '1536x1024', '1024x1536'], qualityOptions: ['low', 'medium', 'high', 'auto'], maxCount: 4, concurrencyLimit: 1, watermark: false,
  },
  {
    id: 'seedream-4-0', displayName: 'Seedream 4.0', adapter: 'seedream', vendorModelId: 'doubao-seedream-4-0-250828', baseUrl: 'https://ark.cn-beijing.volces.com',
    sizes: ['2K', '4K'], qualityOptions: [], maxCount: 4, concurrencyLimit: 1, watermark: false,
  },
  {
    id: 'seedream-4-5', displayName: 'Seedream 4.5', adapter: 'seedream', vendorModelId: 'doubao-seedream-4-5-251128', baseUrl: 'https://ark.cn-beijing.volces.com',
    sizes: ['2K', '4K'], qualityOptions: [], maxCount: 4, concurrencyLimit: 1, watermark: false,
  },
  {
    id: 'seedream-5-lite', displayName: 'Seedream 5.0 Lite', adapter: 'seedream', vendorModelId: 'seedream-5-0-lite', baseUrl: 'https://ark.cn-beijing.volces.com',
    sizes: ['2K', '4K'], qualityOptions: [], maxCount: 4, concurrencyLimit: 1, watermark: false,
  },
] as const
