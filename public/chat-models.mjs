const taskOnlyModel = /(?:^|[\s/_.:-])(?:embeddings?|rerank(?:er|ing)?|ocr|image(?:s)?(?:[-_ ]?(?:generation|gen|understanding|recognition|to[-_ ]text))?|vision(?:[-_ ]?(?:language|instruct))?|visual(?:[-_ ]?(?:question[-_ ]answering|understanding))?|vl|internvl|llava|pixtral|moondream|omni|whisper|speech|audio|tts|asr)(?=$|[\s/_.:-])/iu;
const imageGenerator = /(?:^|[\s/_.:-])(?:flux(?:\.\d+)?|stable[-_ ]diffusion|sdxl|dall[-_ ]?e|imagen(?:[-_ ]?\d+)?|ideogram|recraft|playground(?:[-_ ]?v\d+)?|kolors|cogview)(?=$|[\s/_.:-])/iu;

export function isLanguageChatModel(model) {
  if (typeof model === 'string') return !taskOnlyModel.test(model) && !imageGenerator.test(model);
  if (!model || typeof model !== 'object') return false;
  const identity = [model.id, model.slug, model.name].filter(value => typeof value === 'string').join(' ');
  const task = [model.task, model.task_type, model.model_type, model.type].filter(value => typeof value === 'string').join(' ');
  return Boolean(identity) && !taskOnlyModel.test(identity) && !imageGenerator.test(identity) && !taskOnlyModel.test(task) && !imageGenerator.test(task);
}

export function enabledLanguageChatModels(models, enabledIds) {
  const enabled = new Set(Array.isArray(enabledIds) ? enabledIds.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()) : []);
  const seen = new Set();
  return (Array.isArray(models) ? models : []).filter(model => {
    if (!isLanguageChatModel(model)) return false;
    const id = typeof model === 'string' ? model : model.id || model.slug;
    if (typeof id !== 'string' || !enabled.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// 各模型家族的上下文窗口估算（token）。未匹配到时用通用默认值；
// 弹层展示时标注“估算”，避免把不精确的窗口当成官方参数。
const CONTEXT_WINDOW_RULES = [
  [/gpt-5|codex/iu, 400000],
  [/deepseek/iu, 128000],
  [/qwen3|qwen2\.5|qwen/iu, 131072],
  [/glm-4|glm/iu, 128000],
  [/kimi|moonshot/iu, 256000],
  [/llama/iu, 128000],
  [/mistral|mixtral/iu, 128000],
];
const CONTEXT_WINDOW_DEFAULT = 128000;

export function contextWindowFor(model) {
  const id = String(model || '');
  if (!id.trim()) return CONTEXT_WINDOW_DEFAULT;
  for (const [pattern, size] of CONTEXT_WINDOW_RULES) if (pattern.test(id)) return size;
  return CONTEXT_WINDOW_DEFAULT;
}
