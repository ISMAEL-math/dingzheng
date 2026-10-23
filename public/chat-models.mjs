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
