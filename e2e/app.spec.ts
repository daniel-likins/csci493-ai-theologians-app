import { mkdirSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const APP = 'http://127.0.0.1:47970';
const SHOTS = 'docs/screenshots';
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
mkdirSync(SHOTS, { recursive: true });

test.describe.configure({ mode: 'serial' });

async function call<T = any>(request: APIRequestContext, method: string, path: string, data?: unknown): Promise<T> {
  const { csrfToken } = await (await request.get(`${APP}/api/session`)).json();
  const response = await request.fetch(`${APP}${path}`, { method, headers: { 'x-theologians-csrf': csrfToken }, data });
  expect(response.ok(), `${method} ${path} → ${response.status()} ${await response.text()}`).toBeTruthy();
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const center = (page: Page) => page.locator('section.center');
const panel = (page: Page) => page.locator('aside.goals-panel');

test('home shows three theologian cards and the Round Table', async ({ page }) => {
  await page.goto(APP);
  const cards = page.getByRole('navigation', { name: 'Theologians' }).getByRole('button');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText('Augustine');
  await expect(cards.nth(1)).toContainText('Aquinas');
  await expect(cards.nth(2)).toContainText('Luther');
  await expect(page.getByText('Bring one question to all three.')).toBeVisible();
  await expect(page.locator('time.clock')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/home-light.png` });
});

test('connect a model endpoint from Settings (local test double)', async ({ page }) => {
  await page.goto(`${APP}/settings/models`);
  await expect(page.getByText('About subscriptions.')).toBeVisible();
  await page.getByRole('button', { name: 'Add connection' }).click();
  await page.getByRole('button', { name: /Custom OpenAI-compatible endpoint/ }).click();
  await page.getByLabel('Name').fill('UI test double (not a real model)');
  await page.getByLabel('Authentication').selectOption('none');
  await page.getByLabel('Base URL').fill('http://127.0.0.1:47995/v1');
  await page.getByRole('button', { name: 'Save and test' }).click();
  await expect(page.locator('.status-line strong', { hasText: 'Verified' })).toBeVisible();
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  await page.getByLabel('Display name').fill('Test double');
  await page.getByLabel(/Tool calling/).check();
  await page.getByRole('dialog').getByRole('button', { name: 'Add model', exact: true }).click();
  await expect(page.locator('.model-name', { hasText: 'Test double' })).toBeVisible();
  await page.getByRole('button', { name: 'Send test message' }).click();
  await expect(page.locator('.result-box.ok', { hasText: 'The model replied' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/settings-models-light.png` });
});

test('mission chat: choose a model, stream a reply, label it, and list it in the sidebar', async ({ page, request }) => {
  const models = await call<{ id: string; displayName: string }[]>(request, 'GET', '/api/models');
  const model = models.find((m) => m.displayName === 'Test double')!;
  for (const profile of await call<{ id: string; kind: string }[]>(request, 'GET', '/api/profiles')) {
    if (profile.kind !== 'general') await call(request, 'PATCH', `/api/profiles/${profile.id}`, { preferredModelId: model.id });
  }

  await page.goto(APP);
  await page.getByRole('navigation', { name: 'Theologians' }).getByRole('button', { name: /^Augustine/ }).click();
  await expect(page).toHaveURL(/\/m\/augustine$/);
  await expect(page.getByRole('button', { name: 'Switch theologian' })).toContainText('Augustine');

  await center(page).getByRole('button', { name: /Model and assistant/ }).click();
  await page.getByRole('menuitemradio', { name: /Test double/ }).first().click();
  const box = center(page).getByRole('textbox', { name: 'Message' });
  await box.fill('Explain Augustine on grace briefly');
  await box.press('Enter');

  await expect(page).toHaveURL(/\/m\/augustine\/c\//);
  const reply = center(page).locator('.msg-assistant').last();
  await expect(reply).toContainText('Test double reply', { timeout: 20_000 });
  await expect(reply.locator('.code-block')).toBeVisible();
  await expect(reply.locator('.msg-label')).toContainText('Augustine');
  await expect(reply.locator('.msg-label')).toContainText('Test double');
  await expect(page.locator('.sidebar .chat-link', { hasText: 'Explain Augustine on grace briefly' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/mission-chat-light.png` });

  // Selection stays until changed: the picker still shows the model for the next message.
  await expect(center(page).getByRole('button', { name: /Model and assistant: Test double/ })).toBeVisible();
});

test('folders, rename, move, and search stay inside the mission', async ({ page }) => {
  await page.goto(`${APP}/m/augustine`);
  await page.locator('.sidebar .chat-link', { hasText: 'Explain Augustine on grace briefly' }).click();

  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByPlaceholder('Folder name').fill('Church History');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.folder-toggle', { hasText: 'Church History' })).toBeVisible();

  await center(page).getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('menuitemradio', { name: 'Church History' }).click();
  await expect(page.locator('.folder-children .chat-link', { hasText: 'Explain Augustine' })).toBeVisible();

  await center(page).getByRole('button', { name: /^Rename chat/ }).click();
  await page.getByPlaceholder('Chat title').fill('Grace and free will');
  await page.getByRole('dialog').getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(center(page).locator('.chat-title')).toHaveText('Grace and free will');
  await expect(page.getByRole('dialog', { name: 'Rename chat' })).toHaveCount(0);

  await page.keyboard.press(`${modifier}+k`);
  await page.getByRole('combobox', { name: 'Search chats' }).fill('passage');
  await page.locator('.search-result', { hasText: 'Grace and free will' }).click();
  await expect(page.getByRole('dialog', { name: 'Search Augustine' })).toHaveCount(0);

  await page.goto(`${APP}/m/luther`);
  await expect(page.locator('.sidebar')).not.toContainText('Grace and free will');
  await expect(page.locator('.sidebar')).not.toContainText('Church History');
});

test('drafts survive navigation and a reload', async ({ page }) => {
  await page.goto(`${APP}/m/augustine`);
  await page.locator('.sidebar .chat-link', { hasText: 'Grace and free will' }).click();
  const box = center(page).getByRole('textbox', { name: 'Message' });
  await box.fill('An unsent follow-up thought');
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: /New chat/ }).click();
  await expect(center(page).locator('.new-chat-empty')).toBeVisible();
  await page.locator('.sidebar .chat-link', { hasText: 'Grace and free will' }).click();
  await expect(center(page).getByRole('textbox', { name: 'Message' })).toHaveValue('An unsent follow-up thought');
  await page.reload();
  await expect(center(page).getByRole('textbox', { name: 'Message' })).toHaveValue('An unsent follow-up thought');
  await center(page).getByRole('textbox', { name: 'Message' }).fill('');
  await page.waitForTimeout(900);
});

test('Augustine suggests a memory update that waits for approval', async ({ page, request }) => {
  const augustine = (await call<{ workspaces: { id: string; slug: string }[] }>(request, 'GET', '/api/workspaces')).workspaces.find((w) => w.slug === 'augustine')!;
  await page.goto(`${APP}/m/augustine`);
  // Regression: a message sent from a new chat must not come back as that new chat's draft.
  await expect(center(page).getByRole('textbox', { name: 'Message' })).toHaveValue('');
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole('radio', { name: 'Chat' }).click();
  const box = panel(page).getByRole('textbox', { name: 'Message' });
  await box.fill("I've decided to read the Confessions this month.");
  await box.press('Enter');
  await expect(panel(page).locator('.tool-label', { hasText: 'Memory suggestion' })).toBeVisible({ timeout: 20_000 });
  await expect(panel(page).locator('.msg-assistant').last()).toContainText('waiting for your approval');

  const before = await call<{ items: unknown[]; pendingCount: number }>(request, 'GET', `/api/workspaces/${augustine.id}/memory`);
  expect(before.items).toHaveLength(0);
  expect(before.pendingCount).toBe(1);

  await panel(page).getByRole('radio', { name: /Updates/ }).click();
  const card = panel(page).locator('.proposal').first();
  await expect(card).toContainText('Add to Current focus');
  await expect(card).toContainText('Reading the Confessions this month');
  await page.screenshot({ path: `${SHOTS}/goals-updates-light.png` });
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(panel(page).locator('.history-row').first()).toContainText('Added current focus');

  await panel(page).getByRole('radio', { name: 'Memory' }).click();
  await expect(panel(page).locator('.memory-text', { hasText: 'Reading the Confessions this month' })).toBeVisible();
  const after = await call<{ items: unknown[] }>(request, 'GET', `/api/workspaces/${augustine.id}/memory`);
  expect(after.items).toHaveLength(1);
  await page.screenshot({ path: `${SHOTS}/goals-memory-light.png` });
});

test('the master Goals assistant on Home never changes mission data', async ({ page, request }) => {
  const augustine = (await call<{ workspaces: { id: string; slug: string }[] }>(request, 'GET', '/api/workspaces')).workspaces.find((w) => w.slug === 'augustine')!;
  await call(request, 'PATCH', `/api/workspaces/${augustine.id}/settings`, { memoryAutosave: true });
  const before = await call(request, 'GET', `/api/workspaces/${augustine.id}/memory`);

  await page.goto(APP);
  const box = page.locator('.master').getByRole('textbox', { name: 'Message' });
  await box.fill('I decided I should read more Augustine this week. Remember that and update my Augustine notes.');
  await box.press('Enter');
  await expect(page.locator('.master .msg-assistant').last()).toContainText('Test double reply', { timeout: 20_000 });
  await expect(page.locator('.master .msg-label').last()).toContainText('Round Table');

  const after = await call(request, 'GET', `/api/workspaces/${augustine.id}/memory`);
  expect(after.items).toEqual(before.items);
  expect(after.pendingCount).toBe(before.pendingCount);
  await call(request, 'PATCH', `/api/workspaces/${augustine.id}/settings`, { memoryAutosave: false });
  await page.screenshot({ path: `${SHOTS}/home-master-light.png` });
});

test('stop a response mid-stream; the partial text and your message are kept', async ({ page }) => {
  await page.goto(`${APP}/m/aquinas`);
  await center(page).getByRole('button', { name: /Model and assistant/ }).click();
  await page.getByRole('menuitemradio', { name: /Test double/ }).first().click();
  const box = center(page).getByRole('textbox', { name: 'Message' });
  await box.fill('Please answer slowly');
  await box.press('Enter');
  await expect(center(page).locator('.msg-assistant').last()).toContainText('Test double', { timeout: 20_000 });
  await center(page).getByRole('button', { name: /Stop generating/ }).click();
  await expect(center(page).locator('.stopped')).toContainText('Stopped.');
  await expect(center(page).locator('.msg-user').last()).toContainText('Please answer slowly');
  await expect(center(page).getByRole('button', { name: 'Retry' })).toBeVisible();
});

test('themes, collapsed panels, resizing, and narrow windows', async ({ page }) => {
  await page.goto(`${APP}/settings/general`);
  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.goto(APP);
  await page.screenshot({ path: `${SHOTS}/home-dark.png` });

  await page.goto(`${APP}/m/augustine`);
  await page.locator('.sidebar .chat-link', { hasText: 'Grace and free will' }).click();
  await expect(center(page).locator('.msg-assistant').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/mission-chat-dark.png` });

  const resizer = page.getByRole('separator', { name: 'Resize study notes' });
  const box = await resizer.boundingBox();
  await page.mouse.move(box!.x + 3, box!.y + 200);
  await page.mouse.down();
  await page.mouse.move(box!.x - 120, box!.y + 200, { steps: 8 });
  await page.mouse.up();
  const width = await panel(page).evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(470);

  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/mission-sidebar-hidden-dark.png` });
  await page.getByRole('button', { name: 'Hide study notes' }).click();
  await expect(panel(page)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/mission-focus-dark.png` });

  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);

  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await page.getByRole('button', { name: 'Show study notes' }).click();
  await page.setViewportSize({ width: 900, height: 720 });
  await expect(panel(page)).toHaveClass(/overlay/);
  const centerWidth = await center(page).evaluate((el) => el.getBoundingClientRect().width);
  expect(centerWidth).toBeGreaterThan(420);
  await page.screenshot({ path: `${SHOTS}/mission-narrow-dark.png` });
  await page.setViewportSize({ width: 1360, height: 860 });
  await page.getByRole('button', { name: 'Hide study notes' }).click();
  await page.getByRole('button', { name: 'Show study notes' }).click();

  await panel(page).getByRole('radio', { name: 'Memory' }).click();
  await page.screenshot({ path: `${SHOTS}/goals-memory-dark.png` });

  await page.goto(`${APP}/settings/general`);
  await page.getByRole('radio', { name: 'System' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
});

test('keyboard: focus is visible and menus work without a mouse', async ({ page }) => {
  await page.goto(`${APP}/m/augustine`);
  await page.getByRole('button', { name: 'Switch theologian' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu', { name: 'Switch theologian' })).toBeVisible();
  await expect(page.getByRole('menuitemradio', { name: /^Augustine/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/m\/aquinas$/);
  await page.keyboard.press(`${modifier}+,`);
  await expect(page).toHaveURL(/\/settings\/general$/);
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/settings/);
});
