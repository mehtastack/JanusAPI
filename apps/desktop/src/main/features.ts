import type { Handler } from './router';
import { schemas } from './contract';
import type { AppFeatures } from '../shared/api';

/** Feature switches: the single source of truth. Read per access so tests can flip the env var. */
export const features = {
  /** GraphQL is hidden in the UI unless APIJANUS_FEATURE_GRAPHQL=1. */
  get graphql(): boolean { return process.env.APIJANUS_FEATURE_GRAPHQL === '1'; },
};

/**
 * app:features: the switches and the app facts the window needs at start. secureStorage is decided by main once at startup
 * ('unavailable' on Linux without a keyring; the window then shows a banner, and secrets and cookies are never written).
 */
export function featureHandlers(opts?: { graphql?: boolean; secureStorage?: AppFeatures['secureStorage'] }): Record<'app:features', Handler> {
  return {
    'app:features': {
      schema: schemas['app:features'],
      run: (): AppFeatures => ({ graphql: opts?.graphql ?? features.graphql, secureStorage: opts?.secureStorage ?? 'ok' }),
    },
  };
}
