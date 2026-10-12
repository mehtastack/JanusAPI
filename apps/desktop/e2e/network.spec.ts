import { test, expect } from '@playwright/test';
import { launch } from './helpers';
import { recordingProxy } from '../../../packages/core/test/network-proxy';

test('manual proxy: a demo send goes through the proxy, and not once the proxy is Off', async () => {
  const proxy = await recordingProxy();
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    launched = await launch();
    const { page } = launched;
    await page.getByRole('button', { name: 'Open demo collection' }).click();
    const tree = page.getByRole('tree');
    await expect(tree).toBeVisible();
    const rail = page.getByRole('navigation', { name: 'Sections' });

    // Settings → Network: manual proxy. The demo server is on 127.0.0.1, and loopback is always direct unless the bypass list
    // says <-loopback>.
    await rail.getByRole('button', { name: 'Settings' }).click();
    const network = page.getByRole('region', { name: 'Network' });
    const proxyGroup = network.getByRole('group', { name: 'Proxy' });
    await proxyGroup.getByRole('radio', { name: /Manual proxy/ }).click();
    await expect(proxyGroup.getByRole('radio', { name: /Manual proxy/ })).toBeChecked();
    const url = proxyGroup.getByLabel('Proxy URL');
    await url.fill(proxy.url);
    await url.press('Enter');
    await expect(url).toHaveValue(proxy.url);
    const bypass = proxyGroup.getByLabel('Bypass list');
    await bypass.fill('<-loopback>');
    await bypass.press('Enter');
    await expect(bypass).toHaveValue('<-loopback>');

    const pane = page.getByRole('region', { name: /^Request / });
    const response = page.getByRole('region', { name: 'Response' });
    const send = async () => {
      await rail.getByRole('button', { name: 'Collections' }).click();
      await tree.getByRole('button', { name: /^GET List items/ }).click();
      await expect(pane.getByLabel('URL')).toHaveValue(/\/items/);
      await pane.getByRole('button', { name: 'Send' }).click();
      await expect(response.getByText(/\b200\b/).first()).toBeVisible();
    };

    await send();
    await expect.poll(() => proxy.seen.filter((s) => s.url.includes('/items')).length).toBe(1);

    // Off: the same send connects directly.
    await rail.getByRole('button', { name: 'Settings' }).click();
    await proxyGroup.getByRole('radio', { name: /No proxy/ }).click();
    await expect(proxyGroup.getByRole('radio', { name: /No proxy/ })).toBeChecked();
    const before = proxy.seen.length;
    await send();
    await page.waitForTimeout(1000);
    expect(proxy.seen.length).toBe(before);
  } finally {
    await launched?.app.close();
    await proxy.close();
  }
});
