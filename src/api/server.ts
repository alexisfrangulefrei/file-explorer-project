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

  interface OperationResponseOptions {
    forceFailure?: boolean;
    validationErrors?: string[];
  }

  interface PerformOperationOptions {
    requireSelection?: boolean;
  }

  const sendOperationResponse = (
    res: Response,
    result: OperationResult,
    explorerInstance: FileExplorer,
    failureMessage: string,
    options: OperationResponseOptions = {}
  ): void => {
    const payload = createOperationPayload(result, explorerInstance, options.validationErrors);

    if (options.forceFailure || payload.failed.length) {
      res.status(422).json({
        error: failureMessage,
        details: payload
      });
      return;
    }

    res.json(payload);
  };

  const performSelectionOperation = async (
    res: Response,
    operation: () => Promise<OperationResult>,
    failureMessage: string,
    options: PerformOperationOptions = {}
  ): Promise<void> => {
    if (options.requireSelection && !explorer.getSelection().length) {
      sendOperationResponse(
        res,
        { processed: [], failed: [] },
        explorer,
        failureMessage,
        {
          forceFailure: true,
          validationErrors: ['Selection cannot be empty.']
        }
      );
      return;
    }

    const result = await operation();
    sendOperationResponse(res, result, explorer, failureMessage);
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
      await performSelectionOperation(
        res,
        () => explorer.copySelection(destinationRoot),
        'Failed to copy selection.'
      );
    } catch (error) {
      respondWithError(res, error);
    }
  });

  app.post('/api/selection/move', async (req, res) => {
    try {
      const destinationRoot = parseDestinationRoot(req.body?.destinationRoot);
      await performSelectionOperation(
        res,
        () => explorer.moveSelection(destinationRoot),
        'Failed to move selection.',
        { requireSelection: true }
      );
    } catch (error) {
      respondWithError(res, error);
    }
  });

  app.delete('/api/selection', async (_req, res) => {
    try {
      await performSelectionOperation(
        res,
        () => explorer.deleteSelection(),
        'Failed to delete selection.',
        { requireSelection: true }
      );
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

function createOperationPayload(
  result: OperationResult,
  explorer: FileExplorer,
  validationErrors?: string[]
): {
  processed: string[];
  failed: Array<{ path: string; error: string; code?: string }>;
  selection: string[];
  validationErrors?: string[];
} {
  const payload: {
    processed: string[];
    failed: Array<{ path: string; error: string; code?: string }>;
    selection: string[];
    validationErrors?: string[];
  } = {
    processed: result.processed,
    failed: result.failed.map(({ path: failedPath, error }) => {
      const { message, code } = normalizeOperationError(error);
      return {
        path: failedPath,
        error: message,
        ...(code ? { code } : {})
      };
    }),
    selection: explorer.getSelection()
  };

  if (validationErrors?.length) {
    payload.validationErrors = validationErrors;
  }

  return payload;
}

function normalizeOperationError(error: unknown): { message: string; code?: string } {
  if (error instanceof Error) {
    const nodeError = error as NodeJS.ErrnoException;
    return {
      message: error.message,
      code: typeof nodeError.code === 'string' ? nodeError.code : undefined
    };
  }

  return { message: 'Unknown error' };
}
