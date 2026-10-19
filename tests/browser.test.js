import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../server/index.js';

test('browser: officer, customer, cross-institution reuse, responsive layout and registration', { timeout: 120000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-chain-browser-'));
  const runtime = await createApp({ dataDir: directory, seedDemo: true });
  let server, browser;
  const artifactDir = path.resolve('artifacts/screenshots');
  fs.mkdirSync(artifactDir, { recursive: true });
  try {
    server = await new Promise((resolve, reject) => { const listening = runtime.app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve(listening)); });
    const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : fs.existsSync(systemChrome) ? { executablePath: systemChrome } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('401 (Unauthorized)')) errors.push(message.text()); });
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Your identity workspace.' })).toBeVisible();
    await page.screenshot({ path: path.join(artifactDir, 'login.png'), fullPage: true });
    async function signIn(email) {
      await page.getByLabel('Email address').fill(email);
      await page.getByLabel('Password', { exact: true }).fill('Demo@12345');
      await page.getByRole('button', { name: 'Sign in to workspace' }).click();
      await expect(page.getByRole('heading', { name: /Workspace overview|Your identity, your control.|Consortium overview/ })).toBeVisible();
    }
    async function switchTo(name) {
      const emails = { 'Serendib Finance Request & reuse KYC': 'officer@serendib.demo', 'Customer portal Manage your consent': 'customer@kyc.demo', 'Ceylon Trust Bank Institution officer': 'officer@ceylon.demo' };
      await page.getByRole('button', { name: 'Account settings' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
      await signIn(emails[name]);
    }
    await t.test('officer dashboard, history comparison and integrity check', async () => {
      await signIn('officer@ceylon.demo');
      await expect(page.getByRole('heading', { name: 'Workspace overview' })).toBeVisible();
      await page.screenshot({ path: path.join(artifactDir, 'dashboard.png'), fullPage: true });
      await page.getByRole('link', { name: 'View Asha Senanayake' }).click();
      await expect(page.getByRole('heading', { name: 'Identity details' })).toBeVisible();
      await page.getByRole('button', { name: /^Version 3 / }).click();
      await expect(page.locator('.datum.changed')).toContainText('42 Flower Road');
      await page.getByRole('button', { name: 'Run check' }).click();
      await expect(page.locator('#integrity-result')).toContainText('All 4 accessible versions match');
      await page.screenshot({ path: path.join(artifactDir, 'version-history.png'), fullPage: true });
    });
    await t.test('mobile layout fits viewport and navigation remains usable', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('link', { name: 'Overview', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Workspace overview' })).toBeVisible();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      await page.screenshot({ path: path.join(artifactDir, 'mobile.png'), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1050 });
    });
    await t.test('duplicate lookup stays private before customer approval', async () => {
      await switchTo('Serendib Finance Request & reuse KYC');
      await page.getByRole('link', { name: 'Deduplication', exact: true }).click();
      await page.getByLabel('Document number').fill('199512345678');
      await page.getByRole('button', { name: 'Check for duplicate' }).click();
      await expect(page.locator('#dedup-result')).toContainText('Existing identity found');
      await expect(page.locator('#dedup-result')).not.toContainText('Asha');
      await expect(page.locator('#dedup-result').getByRole('link', { name: 'Open identity' })).toHaveCount(0);
      await page.screenshot({ path: path.join(artifactDir, 'deduplication.png'), fullPage: true });
    });
    await t.test('customer approves and recipient reuses the exact version on-chain', async () => {
      await switchTo('Customer portal Manage your consent');
      await page.getByRole('link', { name: /Consent requests/ }).click();
      await page.getByRole('button', { name: 'Review & approve' }).click();
      await page.getByRole('button', { name: 'Approve & record consent' }).click();
      await expect(page.locator('.consent-card .badge')).toHaveText('✓ approved');
      await switchTo('Serendib Finance Request & reuse KYC');
      await page.getByRole('link', { name: 'View Asha Senanayake' }).click();
      await expect(page.getByRole('heading', { name: 'Version history' })).toBeVisible();
      await expect(page.locator('.version-card')).toHaveCount(1);
      await page.getByRole('button', { name: 'Reuse verification' }).click();
      await expect(page.getByRole('heading', { name: 'Verification reuse' })).toBeVisible();
    });
    await t.test('new identity registration and one-time customer credentials', async () => {
      await switchTo('Ceylon Trust Bank Institution officer');
      await page.getByRole('link', { name: 'Register identity', exact: true }).click();
      await page.getByLabel('Document number').fill('200112345699');
      await page.getByLabel('Document expiry').fill('2033-12-31');
      await page.getByLabel('Full name', { exact: true }).fill('Browser Demo Customer');
      await page.getByLabel('Date of birth').fill('2001-05-06');
      await page.getByLabel('Phone number').fill('+94 77 222 4444');
      await page.getByLabel('Contact email').fill('browser@example.test');
      await page.getByLabel('Residential address').fill('55 Browser Test Road, Colombo');
      await page.getByLabel('Customer portal email').fill('browser@example.test');
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Register & anchor identity' }).click();
      await expect(page.getByRole('heading', { name: 'Customer portal account created' })).toBeVisible();
      await page.getByRole('button', { name: 'I’ve saved the credentials' }).click();
      await expect(page.getByRole('heading', { name: 'Browser Demo Customer' })).toBeVisible();
      await page.getByRole('button', { name: 'Verify record', exact: true }).click();
      await page.getByLabel('Verification notes').fill('Reviewed synthetic record for browser workflow test');
      await page.getByRole('button', { name: 'Verify & anchor version' }).click();
      await expect(page.locator('.profile-banner .badge')).toHaveText('✓ verified');
      await page.getByRole('button', { name: 'New version', exact: true }).click();
      await page.getByLabel('Residential address').fill('77 Updated Browser Road, Kandy');
      await page.getByLabel('Reason for this change').fill('Customer changed their residential address');
      await page.getByRole('button', { name: 'Create version', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Version 3 information' })).toBeVisible();
      await expect(page.locator('.profile-banner .badge')).toHaveText('pending');
    });
    await t.test('audit, network and guide pages render without browser exceptions', async () => {
      await page.getByRole('link', { name: 'Audit trail', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Activity log' })).toBeVisible();
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export CSV' }).click();
      assert.equal((await download).suggestedFilename(), 'kyc-chain-audit.csv');
      await page.getByRole('link', { name: 'Blockchain explorer', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'KYC consortium', exact: true })).toBeVisible();
      await page.screenshot({ path: path.join(artifactDir, 'blockchain.png'), fullPage: true });
      await page.getByRole('link', { name: 'Help Center', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Help Center', exact: true })).toBeVisible();
      await page.getByRole('link', { name: 'Training walkthrough', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Run the five-minute demo' })).toBeVisible();
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
