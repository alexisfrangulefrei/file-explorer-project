import express, { Response } from 'express';
import path from 'path';
import { FileExplorer, NodeFileSystem } from '../class/FileExplorer';

export interface FileExplorerApiOptions {
  explorer?: FileExplorer;
  allowedRoots?: string[];
}

export function createFileExplorerApp(options: FileExplorerApiOptions = {}): express.Express {
  const explorer = options.explorer ?? new FileExplorer(new NodeFileSystem());
  const allowedRoots = (options.allowedRoots?.length ? options.allowedRoots : [process.cwd()])
    .map((root) => path.resolve(root));

  const app = express();
  app.use(express.json());

  const resolveWithinRoots = (inputPath?: string): string => {
    const candidate = path.resolve(inputPath ?? allowedRoots[0]);
    if (!isWithinAllowed(candidate)) {
      throw new Error('Path is outside the allowed roots.');
    }
    return candidate;
  };

  const respondWithError = (res: Response, error: unknown): void => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ error: message });
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

  const isWithinAllowed = (candidate: string): boolean =>
    allowedRoots.some((root) => {
      const relative = path.relative(root, candidate);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });

  return app;
}
