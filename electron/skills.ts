import type { SkillInfo } from '../src/management-types.js';

export async function listSkills(request: (method: string, params: unknown) => Promise<unknown>): Promise<SkillInfo[]> {
  const result = await request('skills.status', { agentId: 'main' });
  if (!result || typeof result !== 'object' || !('skills' in result) || !Array.isArray(result.skills)) {
    throw new Error('网关返回的 Skill 列表格式不受支持。');
  }
  return result.skills.map(value => {
    if (!value || typeof value !== 'object' || typeof value.name !== 'string') {
      throw new Error('网关返回的 Skill 信息格式不受支持。');
    }
    const missing: string[] = [];
    const labels: Record<string, string> = { bins: '命令', anyBins: '可选命令（满足任一）', env: '环境变量', config: '配置', os: '系统' };
    if (value.missing && typeof value.missing === 'object') {
      for (const [key, label] of Object.entries(labels)) {
        const items = value.missing[key];
        if (Array.isArray(items)) {
          const names = items.filter((item: unknown): item is string => typeof item === 'string');
          if (key === 'anyBins' && names.length) missing.push(`${label}：${names.join(' / ')}`);
          else missing.push(...names.map((item: string) => `${label}：${item}`));
        }
      }
    }
    return {
      name: value.name,
      description: typeof value.description === 'string' ? value.description : '',
      source: typeof value.source === 'string' ? value.source : '未知来源',
      eligible: value.eligible === true,
      disabled: value.disabled === true,
      missing,
      ...(typeof value.homepage === 'string' && /^https?:\/\//i.test(value.homepage) ? { homepage: value.homepage } : {}),
    };
  });
}
