import express, { Response } from 'express';
import path from 'path';
import { FileExplorer, NodeFileSystem, OperationResult } from '../class/FileExplorer';

export interface FileExplorerApiOptions {
  explorer?: FileExplorer;
  allowedRoots?: string[];
}

export function createFileExplorerApp(options: FileExplorerApiOptions = {}): express.Express {
  const explorer = options.explorer ?? createDefaultExplorer();
  const allowedRoots = normalizeRoots(options.allowedRoots);

  const app = express();
  app.use(express.json());

  const resolveWithinRoots = (inputPath?: string): string => {
    const candidate = path.resolve(inputPath ?? allowedRoots[0]);
    if (!isWithinAllowed(candidate, allowedRoots)) {
      throw new Error('Path is outside the allowed roots.');
    }
    return candidate;
  };

  const respondWithError = (res: Response, error: unknown): void => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
  };

  const parsePaths = (candidate: unknown): string[] => {
    if (!Array.isArray(candidate) || candidate.some((value) => typeof value !== 'string')) {
      throw new Error('paths must be an array of strings.');
    }
    return candidate as string[];
  };

  const resolveRequestPaths = (candidate: unknown): string[] =>
    parsePaths(candidate).map((entryPath) => resolveWithinRoots(entryPath));

  const parseDestinationRoot = (candidate: unknown): string | undefined => {
    if (candidate == null) {
      return undefined;
    }
    if (typeof candidate !== 'string') {
      throw new Error('destinationRoot must be a string.');
    }
    return resolveWithinRoots(candidate);
  };

  const sendOperationResponse = (
    res: Response,
    result: OperationResult,
    explorerInstance: FileExplorer,
    failureMessage: string
  ): void => {
    const payload = createOperationPayload(result, explorerInstance);

    if (payload.failed.length) {
      res.status(422).json({
        error: failureMessage,
        details: payload
      });
      return;
    }

    res.json(payload);
  };

  app.get('/api/files', async (req, res) => {
    try {
      const directory = resolveWithinRoots(typeof req.query.path === 'string' ? req.query.path : undefined);
      const entries = await explorer.listEntries(directory);
      res.json({
        path: directory,
        entries: entries.map((entry) => ({
          name: entry.name,
          type: entry.type,
          path: entry.path
        }))
      });
    } catch (error) {
      respondWithError(res, error);
    }
  });

  app.get('/api/selection', (_req, res) => {
    res.json(createSelectionPayload(explorer));
  });

  app.post('/api/selection/select', (req, res) => {
    try {
      const resolvedPaths = resolveRequestPaths(req.body?.paths);
      explorer.selectEntries(resolvedPaths);
      res.json(createSelectionPayload(explorer));
    } catch (error) {
      respondWithError(res, error);
    }
  });

  app.post('/api/selection/deselect', (req, res) => {
    try {
      const resolvedPaths = resolveRequestPaths(req.body?.paths);
      explorer.deselectEntries(resolvedPaths);
      res.json(createSelectionPayload(explorer));
    } catch (error) {
      respondWithError(res, error);
    }
  });

  app.post('/api/selection/clear', (_req, res) => {
    try {
      explorer.clearSelection();
      res.json(createSelectionPayload(explorer));
    } catch (error) {
      respondWithError(res, error);
    }
  });

  app.post('/api/selection/copy', async (req, res) => {
    try {
      const destinationRoot = parseDestinationRoot(req.body?.destinationRoot);
      const result = await explorer.copySelection(destinationRoot);
      sendOperationResponse(res, result, explorer, 'Failed to copy selection.');
    } catch (error) {
      respondWithError(res, error);
    }
  });

  app.post('/api/selection/move', async (req, res) => {
    try {
      const destinationRoot = parseDestinationRoot(req.body?.destinationRoot);
      const result = await explorer.moveSelection(destinationRoot);
      sendOperationResponse(res, result, explorer, 'Failed to move selection.');
    } catch (error) {
      respondWithError(res, error);
    }
  });

  return app;
}

function createDefaultExplorer(): FileExplorer {
  return new FileExplorer(new NodeFileSystem());
}

function normalizeRoots(roots?: string[]): string[] {
  const candidates = roots?.length ? roots : [process.cwd()];
  return candidates.map((root) => path.resolve(root));
}

function isWithinAllowed(candidate: string, allowedRoots: string[]): boolean {
  return allowedRoots.some((root) => {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

function createSelectionPayload(explorer: FileExplorer): { selection: string[] } {
  return { selection: explorer.getSelection() };
}

function createOperationPayload(result: OperationResult, explorer: FileExplorer): {
  processed: string[];
  failed: Array<{ path: string; error: string }>;
  selection: string[];
} {
  return {
    processed: result.processed,
    failed: result.failed.map(({ path: failedPath, error }) => ({
      path: failedPath,
      error: error instanceof Error ? error.message : 'Unknown error'
    })),
    selection: explorer.getSelection()
  };
}
