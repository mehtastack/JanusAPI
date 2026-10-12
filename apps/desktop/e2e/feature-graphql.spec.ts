import { test, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { launch } from './helpers';

for (const on of [false, true]) {
  test(`GraphQL switch ${on ? 'on' : 'off'}: New GraphQL request and the demo's GraphQL requests are ${on ? 'present' : 'absent'}`, async () => {
    const launched = await launch(on ? { APIJANUS_FEATURE_GRAPHQL: '1' } : { APIJANUS_FEATURE_GRAPHQL: '' });
    try {
      const { page } = launched;
      await page.getByRole('button', { name: 'Open demo collection' }).click();
      const tree = page.getByRole('tree');
      await expect(tree.getByRole('button', { name: /^GET Get user/ })).toBeVisible();
      const button = page.getByRole('button', { name: 'New GraphQL request' });
      const gql = tree.getByRole('button', { name: /^POST .*\(GraphQL\)$/ });
      if (on) {
        await expect(button).toBeVisible();
        await expect(gql).toHaveCount(2);
      } else {
        await expect(button).toHaveCount(0);
        await expect(gql).toHaveCount(0);
      }
    } finally {
      await launched.app.close().catch(() => undefined);
      await rm(launched.userData, { recursive: true, force: true });
    }
  });
}
