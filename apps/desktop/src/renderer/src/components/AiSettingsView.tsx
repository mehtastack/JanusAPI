import { useRef, useState } from 'react';
import type { AiSettings, ModelOption } from '../../../shared/api';
import { useActions, useApp } from '../App';
import { THEME_SETTINGS, setThemeSetting, useThemeSetting, type ThemeSetting } from '../theme';
import { AboutSettings } from './AboutSettings';
import { CookieManager } from './CookieManager';
import { NetworkSettings } from './NetworkSettings';
import { TextSetting } from './TextSetting';

const PROVIDERS: { value: AiSettings['provider']; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI-compatible' },
  { value: 'ollama', label: 'Ollama' },
];

export function AiSettingsView({ onBack }: { onBack?: () => void }) {
  const ai = useApp((s) => s.ai);
  const theme = useThemeSetting();
  const error = useApp((s) => s.aiError);
  const actions = useActions();
  const keyRef = useRef<HTMLInputElement>(null);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [testing, setTesting] = useState(false);
  if (!ai) {
    return <main className="ai-settings" aria-label="AI provider"><h2>AI provider</h2><p>Loading…</p></main>;
  }
  const s = ai.settings;
  const keyed = s.provider === 'anthropic' || s.provider === 'openai';
  const saveKey = async (key: string | null) => {
    if (s.provider !== 'anthropic' && s.provider !== 'openai') return;
    const ok = await actions.setAiKey(s.provider, key);
    if (ok && keyRef.current) keyRef.current.value = '';
  };
  const test = async () => {
    setTesting(true);
    const found = await actions.testConnection();
    setTesting(false);
    if (found) setModels(found);
  };
  return (
    <main className="ai-settings" aria-label="AI provider">
      {onBack && <div><button type="button" onClick={onBack}>Back</button></div>}
      <h2>AI provider</h2>
      {error && <p role="alert">{error}</p>}
      <fieldset>
        <legend>Provider</legend>
        {PROVIDERS.map((p) => (
          <label key={p.value}>
            <input
              type="radio"
              name="ai-provider"
              checked={s.provider === p.value}
              onChange={() => { setModels(null); void actions.saveAiSettings({ provider: p.value }); }}
            />
            <span>{p.label}</span>
          </label>
        ))}
      </fieldset>
      {keyed && (
        <fieldset key={s.provider}>
          <legend>Credentials</legend>
          <label>
            <span>API key</span>
            <input ref={keyRef} type="password" autoComplete="off" spellCheck={false} />
          </label>
          <button type="button" onClick={() => { const v = keyRef.current?.value.trim(); if (v) void saveKey(v); }}>Save key</button>
          <button type="button" className="danger" onClick={() => void saveKey(null)}>Remove key</button>
          <p>{ai.keys[s.provider as 'anthropic' | 'openai'] ? 'Key stored' : 'No key stored'}</p>
        </fieldset>
      )}
      {s.provider === 'openai' && (
        <TextSetting label="Base URL" stored={s.openaiBaseURL} onSave={(v) => actions.saveAiSettings({ openaiBaseURL: v })} />
      )}
      {s.provider === 'ollama' && (
        <TextSetting label="Endpoint" stored={s.ollamaEndpoint} onSave={(v) => actions.saveAiSettings({ ollamaEndpoint: v })} />
      )}
      {s.provider !== 'none' && (
        <>
          <div>
            <button type="button" disabled={testing} onClick={() => void test()}>Test connection</button>
          </div>
          {models && (
            <ul role="listbox" aria-label="Models">
              {models.length === 0 && <li>No models found</li>}
              {models.map((m) => (
                <li
                  key={m.id}
                  role="option"
                  aria-selected={m.id === s.model}
                  tabIndex={0}
                  onClick={() => void actions.saveAiSettings({ model: m.id })}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void actions.saveAiSettings({ model: m.id }); } }}
                >
                  {m.id}{m.supportsTools && <span className="badge"> tools</span>}
                </li>
              ))}
            </ul>
          )}
          <TextSetting label="Model" stored={s.model} onSave={(v) => actions.saveAiSettings({ model: v })} />
        </>
      )}
      <TextSetting
        label="Temperature"
        stored={String(s.temperature)}
        inputProps={{ type: 'number', min: 0, max: 2, step: 0.1 }}
        onSave={async (v) => { const n = Number(v); return v.trim() !== '' && Number.isFinite(n) ? actions.saveAiSettings({ temperature: n }) : false; }}
      />
      <label>
        <input type="checkbox" checked={s.askBeforeSend} onChange={(e) => void actions.saveAiSettings({ askBeforeSend: e.target.checked })} />
        <span>Ask before sending requests</span>
      </label>
      <label>
        <input type="checkbox" checked={s.forceAssist} onChange={(e) => void actions.saveAiSettings({ forceAssist: e.target.checked })} />
        <span>Force assist mode</span>
      </label>
      <fieldset>
        <legend>Appearance</legend>
        <label>
          <span>Theme</span>
          <select value={theme} onChange={(e) => setThemeSetting(e.target.value as ThemeSetting)}>
            {THEME_SETTINGS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
      </fieldset>
      <NetworkSettings />
      <CookieManager />
      <AboutSettings />
    </main>
  );
}
