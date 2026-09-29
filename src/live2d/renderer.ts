import { Application, Point, ShaderSystem, Texture, utils } from 'pixi.js';
import { install } from '@pixi/unsafe-eval';
import type { Cubism4InternalModel, Live2DModel } from 'pixi-live2d-display/cubism4';
import shizuku from '../../public/live2d/shizuku/shizuku.model3.json';

// Interpreted uniform upload keeps general JavaScript eval disabled.
install({ ShaderSystem });
let corePromise: Promise<void> | undefined;
let loadingQueue = Promise.resolve();

function loadCore(): Promise<void> {
  if (corePromise) return corePromise;
  corePromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = window.setTimeout(() => failed(), 15000);
    const failed = () => {
      window.clearTimeout(timeout);
      script.remove();
      reject(new Error('Live2D 运行库加载失败'));
    };
    script.src = new URL('live2d/core/live2dcubismcore.min.js', document.baseURI).href;
    script.onload = () => { window.clearTimeout(timeout); resolve(); };
    script.onerror = failed;
    document.head.append(script);
  }).catch(error => { corePromise = undefined; throw error; });
  return corePromise;
}

export type CompanionAction = 'Tap' | 'FlickUp' | 'Flick3';

export interface CompanionRenderer {
  greet(): Promise<boolean>;
  interact(action: CompanionAction): Promise<boolean>;
  destroy(): void;
}

export function mountCompanion(host: HTMLDivElement, callbacks: {
  ready(): void;
  error(error: unknown): void;
  motion(name: string): void;
  reducedMotion?(value: boolean): void;
}): CompanionRenderer {
  let disposed = false;
  let loaded = false;
  let failed = false;
  let app: Application | undefined;
  let model: Live2DModel<Cubism4InternalModel> | undefined;
  let observer: ResizeObserver | undefined;
  let removeListeners = () => {};
  let reducedMotion = false;
  let interacting = false;
  const modelURL = new URL('live2d/shizuku/shizuku.model3.json', document.baseURI).href;
  const textureURLs = shizuku.FileReferences.Textures.map(file => new URL(file, modelURL).href);

  const interact = async (action: CompanionAction) => {
    if (!loaded || disposed || failed || reducedMotion || interacting || !model) return false;
    interacting = true;
    try {
      const played = await model.motion(action, 0, 3);
      if (disposed) return false;
      if (played) callbacks.motion(action); else interacting = false;
      return played;
    } catch (error) {
      interacting = false;
      if (!disposed) callbacks.error(error);
      return false;
    }
  };

  const release = () => {
    loaded = false;
    observer?.disconnect();
    removeListeners();
    if (model?.internalModel && !model.destroyed) model.destroy({ texture: true, baseTexture: true });
    model = undefined;
    // A failed ImageResource is cached too; clear only this model's owned URLs.
    for (const url of textureURLs) utils.TextureCache[url]?.destroy(true);
    app?.destroy(true, { children: true });
    app = undefined;
  };

  const load = async () => {
    if (disposed) return;
    try {
      await loadCore();
      const runtime = await import('pixi-live2d-display/cubism4');
      if (disposed) return;
      runtime.config.logLevel = runtime.config.LOG_LEVEL_WARNING;
      app = new Application({
        width: Math.max(host.clientWidth, 1), height: Math.max(host.clientHeight, 1),
        backgroundAlpha: 0, antialias: true, autoDensity: true,
        resolution: Math.min(window.devicePixelRatio || 1, 2), autoStart: false,
      });
      app.ticker.maxFPS = 30;
      const canvas = app.view as HTMLCanvasElement;
      canvas.setAttribute('aria-hidden', 'true');
      host.append(canvas);
      // Await every texture before constructing the model. The library starts
      // these in parallel but cannot expose partially loaded textures on error.
      const textures = await Promise.allSettled(textureURLs.map(url => Texture.fromURL(url)));
      const textureError = textures.find(result => result.status === 'rejected');
      if (textureError?.status === 'rejected') throw textureError.reason;
      if (disposed) { release(); return; }
      // Serial loading prevents a closing model from destroying a newer model's cached textures.
      await new Promise<void>((resolve, reject) => {
        model = runtime.Live2DModel.fromSync(
          modelURL,
          { autoInteract: false, autoUpdate: false, motionPreload: runtime.MotionPreloadStrategy.ALL,
            onLoad: resolve, onError: reject },
        ) as Live2DModel<Cubism4InternalModel>;
      });
      if (disposed) { release(); return; }
      const character = model!;
      const internal = character.internalModel;
      // This Cubism 2 conversion retains its original parameter IDs.
      Object.assign(internal, {
        idParamAngleX: 'PARAM_ANGLE_X', idParamAngleY: 'PARAM_ANGLE_Y', idParamAngleZ: 'PARAM_ANGLE_Z',
        idParamEyeBallX: 'PARAM_EYE_BALL_X', idParamEyeBallY: 'PARAM_EYE_BALL_Y',
        idParamBodyAngleX: 'PARAM_BODY_X', idParamBreath: 'PARAM_BREATH',
      });
      internal.breath.setParameters([
        { parameterId: 'PARAM_ANGLE_X', offset: 0, peak: 3, cycle: 6.5, weight: 0.5 },
        { parameterId: 'PARAM_ANGLE_Z', offset: 0, peak: 2, cycle: 5.5, weight: 0.5 },
        { parameterId: 'PARAM_BREATH', offset: 0.5, peak: 0.5, cycle: 3.2, weight: 1 },
      ]);
      const actions = await Promise.all(['Tap', 'FlickUp', 'Flick3'].map(group => internal.motionManager.loadMotion(group, 0)));
      if (disposed) { release(); return; }
      actions.forEach(action => action?.setIsLoop(false));
      internal.motionManager.on('motionFinish', () => { interacting = false; callbacks.motion('Idle'); });
      app.stage.addChild(character);
      const draw = (advance = false) => {
        if (failed || !app) return;
        try {
          if (advance) character.update(Math.min(app.ticker.deltaMS, 100));
          app.render();
        } catch (error) { failed = true; app.stop(); callbacks.error(error); }
      };
      const fit = () => {
        if (!app || !model) return;
        const width = Math.max(1, host.clientWidth);
        const height = Math.max(1, host.clientHeight);
        app.renderer.resize(width, height);
        const scale = Math.min(width * 0.96 / internal.width, height * 0.96 / internal.height);
        character.scale.set(scale);
        character.position.set((width - internal.width * scale) / 2, (height - internal.height * scale) / 2);
        // Resizing clears WebGL's buffer, even when reduced motion stops the ticker.
        draw();
      };
      fit();
      observer = new ResizeObserver(fit);
      observer.observe(host);

      const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
      const move = (event: PointerEvent) => {
        if (reducedMotion) return;
        const bounds = host.getBoundingClientRect();
        const width = internal.width * character.scale.x;
        const height = internal.height * character.scale.y;
        // Look towards the pointer relative to the character, including when
        // the pointer is in the chat area to the left of the companion.
        internal.focusController.focus(
          Math.max(-1, Math.min(1, (event.clientX - bounds.left - character.x - width / 2) / (width / 2))),
          Math.max(-0.8, Math.min(0.8, (bounds.top + character.y + height * 0.25 - event.clientY) / (height * 0.3))),
        );
      };
      const neutral = () => internal.focusController.focus(0, 0);
      const pointOnCharacter = (event: PointerEvent) => {
        const bounds = host.getBoundingClientRect();
        const point = new Point((event.clientX - bounds.left) * host.clientWidth / bounds.width,
          (event.clientY - bounds.top) * host.clientHeight / bounds.height);
        if (Object.keys(internal.hitAreas).length) return character.hitTest(point.x, point.y).length > 0;
        // Shizuku ships with no HitAreas. Use its visible drawable bounds as
        // the fallback instead of making the entire empty stage clickable.
        const local = character.toModelPosition(point);
        return internal.getDrawableIDs().some((_, index) => {
          if (internal.coreModel.getDrawableOpacity(index) <= 0) return false;
          const area = internal.getDrawableBounds(index);
          return local.x >= area.x && local.x <= area.x + area.width
            && local.y >= area.y && local.y <= area.y + area.height;
        });
      };
      let gesture: { id: number; x: number; y: number } | undefined;
      const pointerDown = (event: PointerEvent) => {
        if (event.button !== 0 || !event.isPrimary || reducedMotion || interacting || !pointOnCharacter(event)) return;
        gesture = { id: event.pointerId, x: event.clientX, y: event.clientY };
        host.setPointerCapture(event.pointerId);
      };
      const pointerUp = (event: PointerEvent) => {
        if (gesture?.id !== event.pointerId) return;
        const start = gesture;
        gesture = undefined;
        if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (dy < -30 && Math.abs(dy) > Math.abs(dx)) void interact('FlickUp');
        else if (Math.abs(dx) > 30 && Math.abs(dx) > Math.abs(dy)) void interact('Flick3');
        else if (Math.hypot(dx, dy) < 12 && pointOnCharacter(event)) void interact('Tap');
      };
      const cancelGesture = () => { gesture = undefined; };
      const visibility = () => {
        if (!app) return;
        if (document.hidden || reducedMotion || failed) app.stop(); else app.start();
      };
      const preferences = () => {
        reducedMotion = preference.matches;
        callbacks.reducedMotion?.(reducedMotion);
        neutral();
        cancelGesture();
        visibility();
      };
      const contextLost = (event: Event) => {
        event.preventDefault();
        failed = true;
        app?.stop();
        callbacks.error(new Error('图形上下文已丢失'));
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('blur', neutral);
      document.documentElement.addEventListener('pointerleave', neutral);
      host.addEventListener('pointerdown', pointerDown);
      host.addEventListener('pointerup', pointerUp);
      host.addEventListener('pointercancel', cancelGesture);
      host.addEventListener('lostpointercapture', cancelGesture);
      document.addEventListener('visibilitychange', visibility);
      preference.addEventListener('change', preferences);
      canvas.addEventListener('webglcontextlost', contextLost);
      removeListeners = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('blur', neutral);
        document.documentElement.removeEventListener('pointerleave', neutral);
        host.removeEventListener('pointerdown', pointerDown);
        host.removeEventListener('pointerup', pointerUp);
        host.removeEventListener('pointercancel', cancelGesture);
        host.removeEventListener('lostpointercapture', cancelGesture);
        document.removeEventListener('visibilitychange', visibility);
        preference.removeEventListener('change', preferences);
        canvas.removeEventListener('webglcontextlost', contextLost);
      };
      // Actual Cubism updates run inside model._render(), not model.update().
      // Own the render callback so both update and draw failures are isolated.
      app.ticker.remove(app.render, app);
      app.ticker.add(() => draw(true));
      character.update(0);
      draw();
      if (failed) { release(); return; }
      loaded = true;
      preferences();
      callbacks.motion('Idle');
      callbacks.ready();
    } catch (error) {
      release();
      if (!disposed) callbacks.error(error);
    }
  };
  loadingQueue = loadingQueue.then(load, load);

  return {
    greet: () => interact('Tap'),
    interact,
    destroy() {
      disposed = true;
      // Pending loads finish in the queue and then release their resources.
      if (loaded) release(); else app?.stop();
    },
  };
}
