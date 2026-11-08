import { describe, expect, it } from 'vitest';
import { NemotronClient, normalizeBaseUrl } from '../../src/llm/nemotron';

describe('normalizeBaseUrl', () => {
  it('appends /v1 to a bare host (the Brev case)', () => {
    expect(normalizeBaseUrl('https://8000-abc.gobrev.dev')).toBe('https://8000-abc.gobrev.dev/v1');
    expect(normalizeBaseUrl('https://8000-abc.gobrev.dev/')).toBe('https://8000-abc.gobrev.dev/v1');
    expect(normalizeBaseUrl('http://localhost:11434')).toBe('http://localhost:11434/v1');
  });
  it('keeps URLs that already have a path', () => {
    expect(normalizeBaseUrl('https://x.dev/v1')).toBe('https://x.dev/v1');
    expect(normalizeBaseUrl('https://x.dev/v1/')).toBe('https://x.dev/v1');
    expect(normalizeBaseUrl('https://integrate.api.nvidia.com/v1')).toBe('https://integrate.api.nvidia.com/v1');
  });
  it('passes empty or malformed input through', () => {
    expect(normalizeBaseUrl('')).toBe('');
    expect(normalizeBaseUrl('not a url')).toBe('not a url');
  });
});

describe('NemotronClient request', () => {
  const answer = '{"vulnerable":["grandmother"],"medical":["insulin"],"hazards":[],"urgency_delta":5,"reasons":["x"],"confidence":"high"}';
  const make = (enableThinking?: boolean) => {
    const bodies: any[] = [];
    const client = { chat: { completions: { create: async (b: any) => { bodies.push(b); return { choices: [{ message: { content: answer } }] }; } } } };
    return { bodies, llm: new NemotronClient({ baseURL: 'https://h', apiKey: 'k', model: 'm', timeoutMs: 1000, enableThinking, client }) };
  };
  it('turns thinking off by default so reasoning models return content', async () => {
    const { bodies, llm } = make();
    expect(await llm.extract({ text: 'insulin', category: 'trapped' })).not.toBeNull();
    expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(bodies[0].max_tokens).toBeGreaterThanOrEqual(600);
  });
  it('leaves thinking alone when enabled explicitly', async () => {
    const { bodies, llm } = make(true);
    await llm.extract({ text: 'x', category: 'trapped' });
    expect(bodies[0].chat_template_kwargs).toBeUndefined();
  });
  it('falls back (null) when a reasoning model returns empty content', async () => {
    const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: null, reasoning: 'thinking...' }, finish_reason: 'length' }] }) } } };
    const llm = new NemotronClient({ baseURL: 'https://h', apiKey: 'k', model: 'm', timeoutMs: 1000, client });
    expect(await llm.extract({ text: 'x', category: 'trapped' })).toBeNull();
  });
});
