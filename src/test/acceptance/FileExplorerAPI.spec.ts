import { test, expect } from '@playwright/test';

const CURRENT_DIRECTORY = '/fixtures/projects/demo-app';
const EXPECTED_ENTRIES = [
  { name: 'README.md', type: 'file' },
  { name: 'package.json', type: 'file' },
  { name: 'src', type: 'directory' }
];

// Step 1 : File explorer API returns a deterministic listing for the mocked directory.
test.describe('File API – list current directory', () => {
  test('returns deterministic listing for the predefined directory', async ({ request }) => {
    const response = await request.get(
      `/api/files?path=${encodeURIComponent(CURRENT_DIRECTORY)}`
    );

    expect(response.ok()).toBe(true);

    const payload = await response.json();
    expect(payload).toEqual({
      path: CURRENT_DIRECTORY,
      entries: EXPECTED_ENTRIES
    });
  });
});
