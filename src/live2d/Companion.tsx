import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Hand, LoaderCircle, RefreshCw } from 'lucide-react';
import type { CompanionAction, CompanionRenderer } from './renderer';
import './companion.css';

const storageKey = 'kuro.companion.collapsed';
export function Companion() {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(storageKey) === 'true'; } catch { return false; }
  });
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [motion, setMotion] = useState('Idle');
  const [retry, setRetry] = useState(0);
  const [greeting, setGreeting] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<CompanionRenderer | undefined>(undefined);

  useEffect(() => {
    if (collapsed || !host.current) return;
    const stage = host.current;
    let cancelled = false;
    let current: CompanionRenderer | undefined;
    setState('loading');
    setMotion('Idle');
    setGreeting(false);
    const failed = (error: unknown) => {
      if (!cancelled) { console.warn('Live2D companion:', error); setState('error'); }
    };
    void import('./renderer').then(({ mountCompanion }) => {
      if (cancelled) return;
      current = mountCompanion(stage, {
        ready: () => { if (!cancelled) setState('ready'); },
        error: failed,
        motion: name => { if (!cancelled) setMotion(name); },
        reducedMotion: value => { if (!cancelled) setReducedMotion(value); },
      });
      renderer.current = current;
    }).catch(failed);
    return () => { cancelled = true; current?.destroy(); renderer.current = undefined; };
  }, [collapsed, retry]);

  const toggle = () => {
    const next = !collapsed;
    // Do not expose the previous instance's ready state before the effect runs.
    setState('loading');
    setMotion('Idle');
    setCollapsed(next);
    try { localStorage.setItem(storageKey, String(next)); } catch { /* Storage is optional. */ }
  };
  const interact = async (action: CompanionAction) => {
    if (greeting) return;
    setGreeting(true);
    await renderer.current?.interact(action);
    setGreeting(false);
  };
  const interactionDisabled = state !== 'ready' || greeting || motion !== 'Idle' || reducedMotion;

  if (collapsed) return <aside className="companion-collapsed" aria-label="聊天陪伴">
    <button onClick={toggle} aria-label="展开角色" title="展开角色"><ChevronLeft size={15} /><span>陪伴</span></button>
  </aside>;

  return <aside className="companion-panel" aria-label="聊天陪伴" data-live2d-state={state} data-live2d-motion={motion}>
    <header className="companion-heading"><strong title="Shizuku · © Live2D Inc.">Shizuku</strong><button className="icon-button" onClick={toggle} aria-label="收起角色" title="收起角色"><ChevronRight size={17} /></button></header>
    <div className="companion-scene">
      <div ref={host} className="live2d-stage" role="img" aria-label="Shizuku 动态陪伴角色" />
      {state === 'loading' && <div className="companion-placeholder" role="status"><LoaderCircle size={22} className="spin" /><span>Shizuku 正在准备…</span></div>}
      {state === 'error' && <div className="companion-placeholder" role="status"><span>角色暂时没能显示<br />你可以继续聊天</span><button className="text-button" onClick={() => { setState('loading'); setRetry(value => value + 1); }}><RefreshCw size={13} />重试加载角色</button></div>}
    </div>
    <div className="companion-footer">
      <button className="secondary-button" disabled={interactionDisabled} onClick={() => void interact('Tap')} aria-label="和 Shizuku 打招呼" title={reducedMotion ? '已按系统设置减少动态效果' : '和 Shizuku 打招呼'}><Hand size={14} />打个招呼</button>
    </div>
  </aside>;
}
