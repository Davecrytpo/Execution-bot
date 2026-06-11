import { logger } from './logger.js';

function isEnabled(value: string | undefined) {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

function renderRuntimeDetected() {
  return isEnabled(process.env.RENDER) || Boolean(process.env.RENDER_EXTERNAL_URL);
}

function componentOverrideName(component: string) {
  return `ALLOW_RENDER_${component.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export async function waitIfRenderRuntimeDisabled(component: string, signal?: AbortSignal) {
  if (!renderRuntimeDetected()) {
    return false;
  }

  const componentOverride = componentOverrideName(component);
  if (isEnabled(process.env.ALLOW_RENDER_RUNTIME) || isEnabled(process.env[componentOverride])) {
    return false;
  }

  logger.info('render_runtime_disabled_for_huggingface_migration', {
    component,
    override: componentOverride
  });

  if (signal?.aborted) {
    return true;
  }

  const keepAlive = setInterval(() => undefined, 60_000);
  await new Promise<void>((resolve) => {
    signal?.addEventListener('abort', () => {
      clearInterval(keepAlive);
      resolve();
    }, { once: true });
  });
  return true;
}
