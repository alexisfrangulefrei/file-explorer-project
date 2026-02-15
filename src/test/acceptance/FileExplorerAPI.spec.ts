import { test, expect } from '@playwright/test';
import type { APIRequestContext, APIResponse } from '@playwright/test';
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

// Starts the API server once for every acceptance test.
test.beforeAll(async () => {
  apiServer = await startServer();
});

// Stops the API server when the suite finishes.
test.afterAll(async () => {
  await stopServer(apiServer);
});

// Step 1 – Deterministic listing endpoint.
// Validates read-only exploration over the deterministic fixture directory.
test.describe('File Explorer API – listing', () => {
  // Ensures the listing endpoint always returns the expected snapshot.
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

// Step 2 – Exploration & selection flows.
// Ensures selection state is empty when the server boots.
test.describe('File Explorer API – selection snapshot', () => {
  // Confirms the default selection is empty before mutations.
  test('returns an empty selection before any interaction', async ({ request }) => {
    await expectSelection(request, []);
  });
});

// Covers mutation endpoints responsible for building up the selection.
test.describe('File Explorer API – selection mutations', () => {
  // Verifies multiple entries can be selected at once.
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

  // Ensures specific entries can be removed while leaving others selected.
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

  // Confirms the clear endpoint wipes the selection in one call.
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

// Step 3 – File operations (copy, move, delete).
// Exercises the copy endpoint for happy and failure paths.
test.describe('File Explorer API – copy selection', () => {
  // Validates successful copy operations keep selection intact.
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

  // Surfaces detailed failures when copy encounters invalid paths.
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

      await expectSelectionOperationFailure(response, 'Failed to copy selection.', {
        processed: [],
        failed: [
          {
            path: missingPath,
            error: expect.stringContaining('ENOENT'),
            code: 'ENOENT'
          }
        ],
        selection: [missingPath]
      });
    } finally {
      await dispose();
    }
  });
});

// Exercises the move endpoint including success, validation, and failure cases.
test.describe('File Explorer API – move selection', () => {
  // Ensures each test starts from a clean selection slate.
  test.beforeEach(async ({ request }) => {
    await request.post('/api/selection/clear');
  });

  // Confirms single-entry moves land inside the destination root.
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

  // Ensures multiple selected entries can be moved at once.
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

  // Validates the API rejects move requests when nothing is selected.
  test('returns a validation error when move is requested with an empty selection', async ({ request }) => {
    const { destinationRoot, dispose } = await useDestinationRoot(request);

    try {
      const response = await request.post('/api/selection/move', {
        data: { destinationRoot }
      });

      await expectEmptySelectionValidationFailure(response, 'Failed to move selection.');
    } finally {
      await dispose();
    }
  });

  // Confirms failures bubble up when the move operation cannot reach sources.
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

      await expectSelectionOperationFailure(response, 'Failed to move selection.', {
        processed: [],
        failed: [
          {
            path: missingPath,
            error: expect.stringContaining('ENOENT'),
            code: 'ENOENT'
          },
          {
            path: missingPathTwo,
            error: expect.stringContaining('ENOENT'),
            code: 'ENOENT'
          }
        ],
        selection: [missingPath, missingPathTwo]
      });
    } finally {
      await dispose();
    }
  });
});

// Covers delete endpoint behavior for success, validation, and error flows.
test.describe('File Explorer API – delete selection', () => {
  // Issues a DELETE request against the selection endpoint.
  const deleteSelection = (request: APIRequestContext) => request.delete('/api/selection');
  // Adds the provided paths to the server-side selection.
  const selectPaths = (request: APIRequestContext, paths: string[]) =>
    request.post('/api/selection/select', {
      data: { paths }
    });

  // Resets the selection before every delete scenario.
  test.beforeEach(async ({ request }) => {
    await request.post('/api/selection/clear');
  });

  // Deletes a single entry and verifies it disappears from disk and selection.
  test('deletes the current selection', async ({ request }) => {
    const { paths: sourcePaths, dispose } = await createTemporarySourceEntries(['temp-delete.txt']);
    const [targetPath] = sourcePaths;

    try {
      await selectPaths(request, [targetPath]);
      await expectSelection(request, [targetPath]);

      const response = await deleteSelection(request);

      expect(response.ok()).toBe(true);
      const payload = await response.json();
      expect(payload).toEqual({
        processed: [targetPath],
        failed: [],
        selection: []
      });

      await assertFileMissing(targetPath);
      await expectSelection(request, []);
    } finally {
      await dispose();
    }
  });

  // Deletes multiple entries at once and ensures deterministic ordering.
  test('deletes multiple entries in a single request', async ({ request }) => {
    const filenames = ['temp-delete-b.txt', 'temp-delete-a.txt'];
    const { paths: sourcePaths, dispose } = await createTemporarySourceEntries(filenames);

    try {
      await selectPaths(request, sourcePaths);
      await expectSelection(request, sourcePaths);

      const response = await deleteSelection(request);

      expect(response.ok()).toBe(true);
      const payload = await response.json();
      expect(payload.processed).toEqual([...sourcePaths].sort());
      expect(payload.failed).toEqual([]);
      expect(payload.selection).toEqual([]);

      await Promise.all(sourcePaths.map(assertFileMissing));
      await expectSelection(request, []);
    } finally {
      await dispose();
    }
  });

  // Validates delete rejects requests without a selection.
  test('returns a validation error when delete is requested with an empty selection', async ({ request }) => {
    const response = await deleteSelection(request);

    await expectEmptySelectionValidationFailure(response, 'Failed to delete selection.');
  });

  // Ensures filesystem failures are reported when delete cannot remove entries.
  test('returns a failure response when delete cannot process the selection', async ({ request }) => {
    const { blockedPath, dispose } = await createDeletionBlockedEntry();

    try {
      await selectPaths(request, [blockedPath]);
      await expectSelection(request, [blockedPath]);

      const response = await deleteSelection(request);

      await expectSelectionOperationFailure(response, 'Failed to delete selection.', {
        processed: [],
        failed: [
          {
            path: blockedPath,
            error: expect.stringMatching(/EACCES|EPERM|ENOTDIR/),
            code: expect.stringMatching(/EACCES|EPERM|ENOTDIR/)
          }
        ],
        selection: [blockedPath]
      });
    } finally {
      await dispose();
    }
  });
});

// Starts the Express app that backs the acceptance tests.
function startServer(): Promise<http.Server> {
  const app = createFileExplorerApp({ allowedRoots: [FIXTURE_ROOT] });
  return new Promise((resolve) => {
    const server = app.listen(4173, () => resolve(server));
  });
}

// Gracefully stops the Express server when tests complete.
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

// Fetches the current selection and asserts it matches the expected snapshot.
async function expectSelection(request: APIRequestContext, expected: string[]): Promise<void> {
  const response = await request.get('/api/selection');
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ selection: expected });
}

// Asserts a 422 response with the canonical empty-selection validation payload.
async function expectEmptySelectionValidationFailure(response: APIResponse, errorMessage: string): Promise<void> {
  expect(response.status()).toBe(422);
  expect(await response.json()).toEqual({
    error: errorMessage,
    details: {
      processed: [],
      failed: [],
      selection: [],
      validationErrors: ['Selection cannot be empty.']
    }
  });
}

// Verifies that a selection mutation failure responds with the provided details.
async function expectSelectionOperationFailure(
  response: APIResponse,
  errorMessage: string,
  expectedDetails: {
    processed: string[];
    failed: Array<{ path: string; error: unknown; code?: unknown }>;
    selection: string[];
  }
): Promise<void> {
  expect(response.status()).toBe(422);
  const payload = await response.json();
  expect(payload.error).toBe(errorMessage);
  expect(payload.details).toEqual(expectedDetails);
}

// Returns a fake path guaranteed to trigger a filesystem error during delete.
async function createDeletionBlockedEntry(): Promise<{ blockedPath: string; dispose: () => Promise<void> }> {
  const blockedPath = path.join(README_PATH, `blocked-child-${Date.now()}`);
  const dispose = async (): Promise<void> => Promise.resolve();
  return { blockedPath, dispose };
}

// Creates and later disposes a temporary directory used as destination roots.
async function useDestinationRoot(request: APIRequestContext): Promise<{ destinationRoot: string; dispose: () => Promise<void> }> {
  const destinationRoot = await fs.mkdtemp(path.join(FIXTURE_ROOT, '.copy-destination-'));
  const dispose = async (): Promise<void> => {
    await fs.rm(destinationRoot, { recursive: true, force: true });
    await request.post('/api/selection/clear');
  };
  return { destinationRoot, dispose };
}

// Ensures a file exists by checking the filesystem for the concrete path.
async function assertFileExists(target: string): Promise<void> {
  const stats = await fs.stat(target);
  expect(stats.isFile()).toBe(true);
}

// Confirms a file is missing by expecting an ENOENT from fs.stat.
async function assertFileMissing(target: string): Promise<void> {
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
}

// Creates temporary source files for move/delete flows and provides cleanup.
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
