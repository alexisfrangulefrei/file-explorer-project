import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { promises as fs } from 'fs';
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
  apiServer = await startServer();
});

test.afterAll(async () => {
  await stopServer(apiServer);
});

// Validates read-only exploration over the deterministic fixture directory.
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

// Ensures selection state is empty when the server boots.
test.describe('File Explorer API – selection snapshot', () => {
  test('returns an empty selection before any interaction', async ({ request }) => {
    await expectSelection(request, []);
  });
});

// Covers mutation endpoints responsible for building up the selection.
test.describe('File Explorer API – selection mutations', () => {
  test('allows selecting multiple paths in a single request', async ({ request }) => {
    await expectSelection(request, []);

    const selectResponse = await request.post('/api/selection/select', {
      data: { paths: [README_PATH, SRC_DIRECTORY] }
    });

    expect(selectResponse.ok()).toBe(true);
    const payload = await selectResponse.json();
    expect(payload).toEqual({ selection: [README_PATH, SRC_DIRECTORY] });

    await expectSelection(request, [README_PATH, SRC_DIRECTORY]);
  });

  test('allows deselecting specific paths without clearing others', async ({ request }) => {
    await request.post('/api/selection/select', {
      data: { paths: [README_PATH, SRC_DIRECTORY] }
    });
    await expectSelection(request, [README_PATH, SRC_DIRECTORY]);

    const response = await request.post('/api/selection/deselect', {
      data: { paths: [README_PATH] }
    });

    expect(response.ok()).toBe(true);
    expect(await response.json()).toEqual({ selection: [SRC_DIRECTORY] });
    await expectSelection(request, [SRC_DIRECTORY]);
  });

  test('clears the entire selection in a single request', async ({ request }) => {
    await request.post('/api/selection/select', {
      data: { paths: [README_PATH, SRC_DIRECTORY] }
    });
    await expectSelection(request, [README_PATH, SRC_DIRECTORY]);

    const response = await request.post('/api/selection/clear');

    expect(response.ok()).toBe(true);
    expect(await response.json()).toEqual({ selection: [] });
    await expectSelection(request, []);
  });
});

test.describe('File Explorer API – copy selection', () => {
  test('copies the current selection into the provided destination root', async ({ request }) => {
    const { destinationRoot, dispose } = await useDestinationRoot(request);
    const expectedReadmeCopy = path.join(destinationRoot, 'README.md');

    try {
      await request.post('/api/selection/select', {
        data: { paths: [README_PATH] }
      });

      const response = await request.post('/api/selection/copy', {
        data: { destinationRoot }
      });

      expect(response.ok()).toBe(true);
      const payload = await response.json();
      expect(payload).toEqual({
        processed: [expectedReadmeCopy],
        failed: [],
        selection: [README_PATH]
      });

      await expectSelection(request, [README_PATH]);
      await assertFileExists(expectedReadmeCopy);
    } finally {
      await dispose();
    }
  });

  test('returns a failure response when copy cannot process the selection', async ({ request }) => {
    const { destinationRoot, dispose } = await useDestinationRoot(request);
    const missingPath = path.join(FIXTURE_ROOT, 'does-not-exist.txt');

    try {
      await request.post('/api/selection/select', {
        data: { paths: [missingPath] }
      });

      const response = await request.post('/api/selection/copy', {
        data: { destinationRoot }
      });

      expect(response.status()).toBe(422);
      const payload = await response.json();
      expect(payload.error).toBe('Failed to copy selection.');
      expect(payload.details).toEqual({
        processed: [],
        failed: [
          {
            path: missingPath,
            error: expect.stringContaining('ENOENT')
          }
        ],
        selection: [missingPath]
      });
    } finally {
      await dispose();
    }
  });
});

test.describe('File Explorer API – move selection', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/api/selection/clear');
  });

  test('moves the current selection into the provided destination root', async ({ request }) => {
    const { destinationRoot, dispose: disposeDestination } = await useDestinationRoot(request);
    const { paths: sourcePaths, dispose: disposeSources } = await createTemporarySourceEntries(['temp-file.txt']);
    const [sourcePath] = sourcePaths;
    const expectedMovedPath = path.join(destinationRoot, path.basename(sourcePath));

    try {
      await request.post('/api/selection/select', {
        data: { paths: [sourcePath] }
      });

      const response = await request.post('/api/selection/move', {
        data: { destinationRoot }
      });

      expect(response.ok()).toBe(true);
      const payload = await response.json();
      expect(payload).toEqual({
        processed: [expectedMovedPath],
        failed: [],
        selection: [expectedMovedPath]
      });

      await assertFileExists(expectedMovedPath);
      await assertFileMissing(sourcePath);
      await expectSelection(request, [expectedMovedPath]);
    } finally {
      await disposeSources();
      await disposeDestination();
    }
  });

  test('moves multiple selected entries in one request', async ({ request }) => {
    const { destinationRoot, dispose: disposeDestination } = await useDestinationRoot(request);
    const filenames = ['temp-b.txt', 'temp-a.txt'];
    const { paths: sourcePaths, dispose: disposeSources } = await createTemporarySourceEntries(filenames);
    const expectedMovedPaths = sourcePaths
      .map((sourcePath) => path.join(destinationRoot, path.basename(sourcePath)))
      .sort();

    try {
      await request.post('/api/selection/select', {
        data: { paths: sourcePaths }
      });

      const response = await request.post('/api/selection/move', {
        data: { destinationRoot }
      });

      expect(response.ok()).toBe(true);
      const payload = await response.json();
      expect(payload.processed).toEqual(expectedMovedPaths);
      expect(payload.failed).toEqual([]);
      expect(payload.selection).toEqual(expectedMovedPaths);

      await Promise.all(expectedMovedPaths.map(assertFileExists));
      await Promise.all(sourcePaths.map(assertFileMissing));
      await expectSelection(request, expectedMovedPaths);
    } finally {
      await disposeSources();
      await disposeDestination();
    }
  });

  test('returns a validation error when move is requested with an empty selection', async ({ request }) => {
    const { destinationRoot, dispose } = await useDestinationRoot(request);

    try {
      const response = await request.post('/api/selection/move', {
        data: { destinationRoot }
      });

      expect(response.status()).toBe(422);
      const payload = await response.json();
      expect(payload).toEqual({
        error: 'Failed to move selection.',
        details: {
          processed: [],
          failed: [],
          selection: []
        }
      });
    } finally {
      await dispose();
    }
  });

  test('returns a failure response when move cannot process the selection', async ({ request }) => {
    const { destinationRoot, dispose } = await useDestinationRoot(request);
    const missingPath = path.join(FIXTURE_ROOT, 'missing-move-source.txt');
    const missingPathTwo = path.join(FIXTURE_ROOT, 'missing-move-source-2.txt');

    try {
      await request.post('/api/selection/select', {
        data: { paths: [missingPath, missingPathTwo] }
      });

      const response = await request.post('/api/selection/move', {
        data: { destinationRoot }
      });

      expect(response.status()).toBe(422);
      const payload = await response.json();
      expect(payload.error).toBe('Failed to move selection.');
      expect(payload.details).toEqual({
        processed: [],
        failed: [
          {
            path: missingPath,
            error: expect.stringContaining('ENOENT')
          },
          {
            path: missingPathTwo,
            error: expect.stringContaining('ENOENT')
          }
        ],
        selection: [missingPath, missingPathTwo]
      });
    } finally {
      await dispose();
    }
  });
});

function startServer(): Promise<http.Server> {
  const app = createFileExplorerApp({ allowedRoots: [FIXTURE_ROOT] });
  return new Promise((resolve) => {
    const server = app.listen(4173, () => resolve(server));
  });
}

function stopServer(server?: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function expectSelection(request: APIRequestContext, expected: string[]): Promise<void> {
  const response = await request.get('/api/selection');
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ selection: expected });
}

async function useDestinationRoot(request: APIRequestContext): Promise<{ destinationRoot: string; dispose: () => Promise<void> }> {
  const destinationRoot = await fs.mkdtemp(path.join(FIXTURE_ROOT, '.copy-destination-'));
  const dispose = async (): Promise<void> => {
    await fs.rm(destinationRoot, { recursive: true, force: true });
    await request.post('/api/selection/clear');
  };
  return { destinationRoot, dispose };
}

async function assertFileExists(target: string): Promise<void> {
  const stats = await fs.stat(target);
  expect(stats.isFile()).toBe(true);
}

async function assertFileMissing(target: string): Promise<void> {
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function createTemporarySourceEntries(filenames: string[]): Promise<{ paths: string[]; dispose: () => Promise<void> }> {
  const directory = await fs.mkdtemp(path.join(FIXTURE_ROOT, '.move-source-'));
  const paths = await Promise.all(
    filenames.map(async (filename) => {
      const filePath = path.join(directory, filename);
      await fs.writeFile(filePath, `temporary content for ${filename}`);
      return filePath;
    })
  );
  const dispose = async (): Promise<void> => {
    await fs.rm(directory, { recursive: true, force: true });
  };
  return { paths, dispose };
}
