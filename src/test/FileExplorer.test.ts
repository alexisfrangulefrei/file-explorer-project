import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  DirectoryNameGenerator,
  FileEntry,
  FileExplorer,
  FileSystemDirEntry,
  FileSystemPort,
  FileSystemStatsSnapshot,
  RandomDirectoryNameGenerator,
  RandomPort
} from '../class/FileExplorer';

const createEntry = (name: string, type: 'file' | 'directory', base = '/root'): FileEntry => ({
  name,
  path: `${base}/${name}`,
  type
});

const createDirent = (name: string, type: 'file' | 'directory'): FileSystemDirEntry => ({
  name,
  type
});

const createStats = (type: 'file' | 'directory'): FileSystemStatsSnapshot => ({ type });

class FakeFs implements FileSystemPort {
  readDir = vi.fn<FileSystemPort['readDir']>();
  stat = vi.fn<FileSystemPort['stat']>();
  copyFile = vi.fn<FileSystemPort['copyFile']>();
  mkdir = vi.fn<FileSystemPort['mkdir']>();
  rm = vi.fn<FileSystemPort['rm']>();
  rename = vi.fn<FileSystemPort['rename']>();
  exists = vi.fn<FileSystemPort['exists']>();
}

class SequenceDirectoryNameGenerator implements DirectoryNameGenerator {
  constructor(private readonly names: string[]) {}
  generate(): string {
    const name = this.names.shift();
    if (!name) {
      throw new Error('No names left');
    }
    return name;
  }
}

class SequenceRandomPort implements RandomPort {
  constructor(private readonly values: number[]) {}
  next(): number {
    const value = this.values.shift();
    if (value == null) {
      throw new Error('No random values left');
    }
    return value;
  }
}

describe('FileExplorer', () => {
  let fsPort: FakeFs;
  let explorer: FileExplorer;

  // Feature: Step 3 (Step 2 requirement) – Allow injecting fake FS and RNG to satisfy testability requirement.
  beforeEach(() => {
    fsPort = new FakeFs();
    explorer = new FileExplorer(
      fsPort,
      new SequenceDirectoryNameGenerator(['occupied-name', 'adjective-noun'])
    );
  });

  describe('Step 3 – Core navigation and operations (tests steps 1 & 2 requirements)', () => {
    // Feature: Step 3 (Step 1 requirement) – Directory enumeration.
    describe('listEntries', () => {
      // Verifies listing order and metadata shape.
      it('sorts entries alphabetically and returns metadata', async () => {
        fsPort.readDir.mockResolvedValue([
          createDirent('b.txt', 'file'),
          createDirent('a-folder', 'directory')
        ]);

        const entries = await explorer.listEntries('/root');

        expect(entries).toEqual([
          createEntry('a-folder', 'directory'),
          createEntry('b.txt', 'file')
        ]);
      });
    });

    // Feature: Step 3 (Step 1 requirement) – Selection management lifecycle.
    describe('selection management', () => {
      // Confirms arbitrary entries can be added to selection.
      it('selects specific entries and retrieves them', () => {
        explorer.selectEntries(['/root/a', '/root/b']);
        expect(explorer.getSelection()).toEqual([
          '/root/a',
          '/root/b'
        ]);
      });

      // Ensures selectAll replaces existing selection.
      it('selects all entries', () => {
        const entries = [createEntry('a', 'file'), createEntry('b', 'file')];
        explorer.selectEntries(['/root/c']);
        explorer.selectAll(entries);
        expect(explorer.getSelection()).toEqual(['/root/a', '/root/b']);
      });

      // Checks deselectEntries removes targeted paths.
      it('deselects entries', () => {
        explorer.selectEntries(['/root/a', '/root/b']);
        explorer.deselectEntries(['/root/b']);
        expect(explorer.getSelection()).toEqual(['/root/a']);
      });

      // Ensures clearSelection empties selection.
      it('clears selection', () => {
        explorer.selectEntries(['/root/a']);
        explorer.clearSelection();
        expect(explorer.getSelection()).toEqual([]);
      });
    });

    // Feature: Step 3 (Step 1 requirement) – Copy selection.
    describe('copy selection', () => {
      // Copies files to explicit destination root.
      it('copies selected entries into provided destination', async () => {
        explorer.selectEntries(['/root/file']);
        fsPort.stat.mockResolvedValue(createStats('file'));
        fsPort.exists.mockResolvedValue(false);
        fsPort.mkdir.mockResolvedValue();
        fsPort.copyFile.mockResolvedValue();

        const result = await explorer.copySelection('/dest');

        expect(fsPort.mkdir).toHaveBeenCalledWith('/dest', { recursive: true });
        expect(fsPort.copyFile).toHaveBeenCalledWith('/root/file', '/dest/file');
        expect(result.processed).toEqual(['/dest/file']);
        expect(result.failed).toEqual([]);
      });

      // Feature: Step 3 (Step 1 requirement) – Recursively copy directories.
      it('recursively copies directories', async () => {
        explorer.selectEntries(['/root/dir']);
        fsPort.stat.mockResolvedValueOnce(createStats('directory'));
        fsPort.mkdir.mockResolvedValue();
        fsPort.exists.mockResolvedValue(false);
        fsPort.readDir.mockResolvedValue([
          createDirent('nested.txt', 'file')
        ]);
        fsPort.stat.mockResolvedValueOnce(createStats('file'));
        fsPort.copyFile.mockResolvedValue();

        const result = await explorer.copySelection('/dest');

        expect(fsPort.copyFile).toHaveBeenCalledWith('/root/dir/nested.txt', '/dest/dir/nested.txt');
        expect(result.processed).toEqual(['/dest/dir']);
        expect(result.failed).toEqual([]);
      });
    });

    // Feature: Step 3 (Step 1 requirement) – Move selection.
    describe('move selection', () => {
      // Prefers rename when moving entries.
      it('moves files using rename when possible', async () => {
        explorer.selectEntries(['/root/file']);
        fsPort.exists.mockResolvedValue(false);
        fsPort.mkdir.mockResolvedValue();
        fsPort.rename.mockResolvedValue();

        const result = await explorer.moveSelection('/dest');

        expect(fsPort.rename).toHaveBeenCalledWith('/root/file', '/dest/file');
        expect(result.processed).toEqual(['/dest/file']);
        expect(result.failed).toEqual([]);
        expect(explorer.getSelection()).toEqual(['/dest/file']);
      });
    });

    // Feature: Step 3 (Step 1 requirement) – Delete selection.
    describe('delete selection', () => {
      // Deletes selected entries and clears their selection state.
      it('deletes selected entries and clears them', async () => {
        explorer.selectEntries(['/root/a', '/root/b']);
        fsPort.rm.mockResolvedValue();

        const result = await explorer.deleteSelection();

        expect(fsPort.rm).toHaveBeenCalledTimes(2);
        expect(result.processed).toEqual(['/root/a', '/root/b']);
        expect(result.failed).toEqual([]);
        expect(explorer.getSelection()).toEqual([]);
      });
    });
  });

  // Feature: Step 3 (Step 2 requirement) – Dependency injection for testability.
  describe('dependency injection for testability', () => {
    // Demonstrates explorer honoring injected directory name generator.
    it('uses injected directory name generator when destination is omitted', async () => {
      explorer.selectEntries(['/root/file']);
      fsPort.stat.mockResolvedValue(createStats('file'));
      fsPort.exists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      fsPort.mkdir.mockResolvedValue();
      fsPort.copyFile.mockResolvedValue();

      const result = await explorer.copySelection();

      expect(fsPort.mkdir).toHaveBeenCalledWith('/root/adjective-noun', { recursive: true });
      expect(result.processed).toEqual(['/root/adjective-noun/file']);
      expect(result.failed).toEqual([]);
    });
  });

  // Feature: Step 3 (Step 2 requirement) & Step 4 – Randomized destination handling
  describe('randomized destination handling', () => {
    // Feature: Step 3 (Step 2 requirement) & Step 4 – Ensures collisions beyond the retry limit fall back to numbered names.
    it('numbers destination after exceeding random attempts', async () => {
      explorer = new FileExplorer(
        fsPort,
        new SequenceDirectoryNameGenerator(new Array(10).fill('conflict'))
      );
      explorer.selectEntries(['/root/file']);
      fsPort.stat.mockResolvedValue(createStats('file'));
      for (let i = 0; i < 10; i++) {
        fsPort.exists.mockResolvedValueOnce(true);
      }
      fsPort.exists.mockResolvedValueOnce(false);
      fsPort.mkdir.mockResolvedValue();
      fsPort.copyFile.mockResolvedValue();

      const result = await explorer.copySelection();

      expect(fsPort.mkdir).toHaveBeenCalledWith('/root/conflict-1', { recursive: true });
      expect(result.processed).toEqual(['/root/conflict-1/file']);
      expect(result.failed).toEqual([]);
    });

    // Feature: Step 3 (Step 2 requirement) – Falls back to copy/delete when rename fails.
    it('falls back to copy/delete when rename fails', async () => {
      explorer.selectEntries(['/root/file']);
      fsPort.exists.mockResolvedValue(false);
      fsPort.mkdir.mockResolvedValue();
      fsPort.rename.mockRejectedValue(new Error('nope'));
      fsPort.stat.mockResolvedValue(createStats('file'));
      fsPort.copyFile.mockResolvedValue();
      fsPort.rm.mockResolvedValue();

      const result = await explorer.moveSelection('/dest');

      expect(fsPort.copyFile).toHaveBeenCalledWith('/root/file', '/dest/file');
      expect(fsPort.rm).toHaveBeenCalledWith('/root/file', { recursive: true, force: true });
      expect(result.processed).toEqual(['/dest/file']);
      expect(result.failed).toEqual([]);
    });

    // Feature: Step 3 (Step 2 requirement) – Random name generation via pluggable RNG.
    describe('random name generation', () => {
      // Produces deterministic names when RNG sequence is injected.
      it('uses provided random port to pick words deterministically', () => {
        const random = new SequenceRandomPort([0.1, 0.9]);
        const generator = new RandomDirectoryNameGenerator(undefined, undefined, random);
        const name = generator.generate();
        expect(name).toMatch(/^[a-z]+-[a-z]+$/);
      });
    });
  });

  // Feature: Step 4 - Error reporting.
  describe('error reporting', () => {
    // Feature: Step 4 – Reports copy errors with OperationResult while retaining selection.
    it('reports copy failures and preserves selection for failed entries', async () => {
      explorer.selectEntries(['/root/ok', '/root/fail']);
      fsPort.stat
        .mockResolvedValueOnce(createStats('file'))
        .mockRejectedValueOnce(new Error('stat-fail'));
      fsPort.exists.mockResolvedValue(false);
      fsPort.mkdir.mockResolvedValue();
      fsPort.copyFile.mockResolvedValueOnce();

      const outcome = await explorer.copySelection('/dest');

      expect(outcome.processed).toEqual(['/dest/ok']);
      expect(outcome.failed).toHaveLength(1);
      expect(outcome.failed[0].path).toBe('/root/fail');
      expect(outcome.failed[0].error).toBeInstanceOf(Error);
      expect(explorer.getSelection()).toEqual(['/root/ok', '/root/fail']);
    });

    // Feature: Step 4 – Reports move failures and keeps unsuccessful entries selected.
    it('reports move failures and keeps failed entries selected', async () => {
      explorer.selectEntries(['/root/ok', '/root/fail']);
      fsPort.exists.mockResolvedValue(false);
      fsPort.mkdir.mockResolvedValue();
      fsPort.rename.mockResolvedValueOnce();
      fsPort.rename.mockRejectedValueOnce(new Error('rename-fail'));
      fsPort.stat.mockRejectedValueOnce(new Error('stat-fail'));

      const result = await explorer.moveSelection('/dest');

      expect(result.processed).toEqual(['/dest/ok']);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].path).toBe('/root/fail');
      expect(explorer.getSelection().sort()).toEqual(['/dest/ok', '/root/fail'].sort());
    });

    // Feature: Step 4 – Reports delete failures and keeps failed entries selected.
    it('reports delete failures and keeps failed entries selected', async () => {
      explorer.selectEntries(['/root/ok', '/root/fail']);
      fsPort.rm.mockResolvedValueOnce(undefined);
      fsPort.rm.mockRejectedValueOnce(new Error('rm-fail'));

      const result = await explorer.deleteSelection();

      expect(result.processed).toEqual(['/root/ok']);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].path).toBe('/root/fail');
      expect(explorer.getSelection()).toEqual(['/root/fail']);
    });
  });
});
