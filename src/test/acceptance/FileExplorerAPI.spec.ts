import { test, expect } from '@playwright/test';
import http from 'http';
import path from 'path';
import { createFileExplorerApp } from '../../api/server';

const FIXTURE_ROOT = path.join(process.cwd(), 'fixtures/projects/demo-app');
const CURRENT_DIRECTORY = FIXTURE_ROOT;
const README_PATH = path.join(FIXTURE_ROOT, 'README.md');
const PACKAGE_PATH = path.join(FIXTURE_ROOT, 'package.json');
const SRC_DIRECTORY = path.join(FIXTURE_ROOT, 'src');

const EXPECTED_ENTRIES = [
  { name: 'package.json', type: 'file', path: PACKAGE_PATH },
  { name: 'README.md', type: 'file', path: README_PATH },
  { name: 'src', type: 'directory', path: SRC_DIRECTORY }
];

let apiServer: http.Server;

test.beforeAll(async () => {
  const app = createFileExplorerApp({ allowedRoots: [FIXTURE_ROOT] });
  await new Promise<void>((resolve) => {
    apiServer = app.listen(4173, resolve);
  });
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!apiServer) {
      resolve();
      return;
    }
    apiServer.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
});

test.describe('File Explorer API – listing', () => {
  test('returns deterministic listing for the predefined directory', async ({ request }) => {
    const response = await request.get(`/api/files?path=${encodeURIComponent(CURRENT_DIRECTORY)}`);

    expect(response.ok()).toBe(true);

    const payload = await response.json();
    expect(payload).toEqual({
      path: CURRENT_DIRECTORY,
      entries: EXPECTED_ENTRIES
    });
  });
});
