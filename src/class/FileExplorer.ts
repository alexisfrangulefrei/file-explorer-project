import { Dirent, promises as fsPromises } from 'fs';
import * as path from 'path';

export type EntryType = 'file' | 'directory';

export interface FileEntry {
  path: string;
  name: string;
  type: EntryType;
}

export interface FileSystemDirEntry {
  name: string;
  type: EntryType;
}

export interface FileSystemStatsSnapshot {
  type: EntryType;
}

export interface FileSystemPort {
  readDir(targetPath: string): Promise<FileSystemDirEntry[]>;
  stat(targetPath: string): Promise<FileSystemStatsSnapshot>;
  copyFile(source: string, destination: string): Promise<void>;
  mkdir(targetPath: string, options?: { recursive?: boolean }): Promise<void>;
  rm(targetPath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  exists(targetPath: string): Promise<boolean>;
}

export interface DirectoryNameGenerator {
  generate(): string;
}

export interface RandomPort {
  next(): number;
}

export interface OperationFailure {
  path: string;
  error: unknown;
}

export interface OperationResult {
  processed: string[];
  failed: OperationFailure[];
}

export class MathRandomPort implements RandomPort {
  // Provides Math.random-backed entropy.
  next(): number {
    return Math.random();
  }
}

const DEFAULT_ADJECTIVES: readonly string[] = [
  'brisk',
  'calm',
  'clever',
  'crisp',
  'daring',
  'eager',
  'fierce',
  'gentle',
  'glossy',
  'humble',
  'lively',
  'nimble',
  'noble',
  'plucky',
  'proud',
  'rapid',
  'rugged',
  'shiny',
  'steady',
  'swift'
];

const DEFAULT_NOUNS: readonly string[] = [
  'atlas',
  'boulder',
  'canyon',
  'cedar',
  'delta',
  'ember',
  'harbor',
  'horizon',
  'lagoon',
  'meadow',
  'mesa',
  'nebula',
  'oasis',
  'prairie',
  'quartz',
  'ridge',
  'summit',
  'terrace',
  'vale',
  'vista'
];

export class RandomDirectoryNameGenerator implements DirectoryNameGenerator {
  // Builds a generator while validating adjective and noun dictionaries.
  constructor(
    private readonly adjectives: readonly string[] = DEFAULT_ADJECTIVES,
    private readonly nouns: readonly string[] = DEFAULT_NOUNS,
    private readonly random: RandomPort = new MathRandomPort()
  ) {
    if (!adjectives.length || !nouns.length) {
      throw new Error('Both dictionaries must contain at least one entry.');
    }
  }

  // Supplies a random adjective-noun directory name pair.
  generate(): string {
    const adjective = this.pickOne(this.adjectives);
    const noun = this.pickOne(this.nouns);
    return `${adjective}-${noun}`;
  }

  // Picks a single word from the provided dictionary using RNG.
  private pickOne(dictionary: readonly string[]): string {
    const index = Math.floor(this.random.next() * dictionary.length);
    return dictionary[index];
  }
}

export class NodeFileSystem implements FileSystemPort {
  // Reads directory entries with simple, mockable metadata.
  async readDir(targetPath: string): Promise<FileSystemDirEntry[]> {
    const entries = await fsPromises.readdir(targetPath, { withFileTypes: true });
    return entries.map((dirent) => this.toDirEntry(dirent));
  }

  // Retrieves filesystem statistics for a given path.
  async stat(targetPath: string): Promise<FileSystemStatsSnapshot> {
    const stats = await fsPromises.stat(targetPath);
    return { type: stats.isDirectory() ? 'directory' : 'file' };
  }

  // Copies a file from source to destination.
  copyFile(source: string, destination: string): Promise<void> {
    return fsPromises.copyFile(source, destination);
  }

  // Creates a directory hierarchy as needed.
  async mkdir(targetPath: string, options?: { recursive?: boolean }): Promise<void> {
    await fsPromises.mkdir(targetPath, options);
  }

  // Removes files or directories recursively when required.
  rm(targetPath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    return fsPromises.rm(targetPath, options);
  }

  // Moves or renames a filesystem entry.
  rename(source: string, destination: string): Promise<void> {
    return fsPromises.rename(source, destination);
  }

  // Checks whether a path exists without throwing on absence.
  async exists(targetPath: string): Promise<boolean> {
    try {
      await fsPromises.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  // Converts Node.js Dirent into a test-friendly structure.
  private toDirEntry(dirent: Dirent): FileSystemDirEntry {
    return {
      name: dirent.name,
      type: dirent.isDirectory() ? 'directory' : 'file'
    };
  }
}

export class FileExplorer {
  private readonly selection = new Set<string>();

  // Initializes the explorer with pluggable filesystem and naming services.
  constructor(
    private readonly fsPort: FileSystemPort = new NodeFileSystem(),
    private readonly directoryNameGenerator: DirectoryNameGenerator = new RandomDirectoryNameGenerator()
  ) {}

  // Lists directory entries in alphabetical order with metadata.
  async listEntries(directory: string): Promise<FileEntry[]> {
    const absoluteDirectory = path.resolve(directory);
    const entries = await this.fsPort.readDir(absoluteDirectory);

    return entries
      .map((dirent) => this.toFileEntry(absoluteDirectory, dirent))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Adds arbitrary paths to the current selection.
  selectEntries(paths: string[]): void {
    paths.forEach((entryPath) => this.selection.add(path.resolve(entryPath)));
  }

  // Replaces current selection with every provided entry.
  selectAll(entries: FileEntry[]): void {
    this.selection.clear();
    this.selectEntries(entries.map((entry) => entry.path));
  }

  // Removes specific paths from the selection set.
  deselectEntries(paths: string[]): void {
    paths.forEach((entryPath) => this.selection.delete(path.resolve(entryPath)));
  }

  // Clears the selection entirely.
  clearSelection(): void {
    this.selection.clear();
  }

  // Returns a snapshot of the selected paths.
  getSelection(): string[] {
    return [...this.selection];
  }

  // Copies every selected entry into the destination root or a generated directory.
  async copySelection(destinationRoot?: string): Promise<OperationResult> {
    const selected = this.snapshotSelection();
    const destination = await this.resolveDestination(selected, destinationRoot);
    await this.fsPort.mkdir(destination, { recursive: true });

    return this.runOperation(selected, async (source) => {
      const target = path.join(destination, path.basename(source));
      await this.copyEntryRecursive(source, target);
      return target;
    });
  }

  // Moves the selection, generating a destination when none is provided.
  async moveSelection(destinationRoot?: string): Promise<OperationResult> {
    const selected = this.snapshotSelection();
    const destination = await this.resolveDestination(selected, destinationRoot);
    await this.fsPort.mkdir(destination, { recursive: true });

    return this.runOperation(selected, async (source) => {
      const target = path.join(destination, path.basename(source));
      await this.moveEntry(source, target);
      this.selection.delete(source);
      this.selection.add(target);
      return target;
    });
  }

  // Deletes all selected entries from the filesystem.
  async deleteSelection(): Promise<OperationResult> {
    return this.runOperation(this.snapshotSelection(), async (source) => {
      await this.fsPort.rm(source, { recursive: true, force: true });
      this.selection.delete(source);
      return source;
    });
  }

  // Translates a filesystem entry into a FileEntry with absolute data.
  private toFileEntry(directory: string, dirent: FileSystemDirEntry): FileEntry {
    const entryPath = path.join(directory, dirent.name);
    return {
      path: entryPath,
      name: dirent.name,
      type: dirent.type
    };
  }

  // Guarantees that at least one entry is selected before acting.
  private ensureSelection(): void {
    if (!this.selection.size) {
      throw new Error('No entries selected.');
    }
  }

  // Produces a snapshot of the current selection while enforcing its presence.
  private snapshotSelection(): string[] {
    this.ensureSelection();
    return [...this.selection];
  }

  // Computes the destination directory, generating a unique name when missing.
  private async resolveDestination(selection: string[], destinationRoot?: string): Promise<string> {
    if (destinationRoot) {
      return path.resolve(destinationRoot);
    }

    const parentDirectory = path.dirname(selection[0]);
    const { candidate, lastRandomName } = await this.tryRandomDestination(parentDirectory);
    if (candidate) {
      return candidate;
    }

    return this.generateNumberedDestination(parentDirectory, lastRandomName);
  }

  // Attempts to find a free directory using random names.
  private async tryRandomDestination(parentDirectory: string): Promise<{ candidate: string | null; lastRandomName: string | null }> {
    const maxAttempts = 10;
    let lastRandomName: string | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const randomName = this.directoryNameGenerator.generate();
      lastRandomName = randomName;
      const candidate = path.join(parentDirectory, randomName);
      if (!(await this.fsPort.exists(candidate))) {
        return { candidate, lastRandomName };
      }
    }

    return { candidate: null, lastRandomName };
  }

  // Falls back to suffixing the last random name (or a fresh one) until unique.
  private async generateNumberedDestination(parentDirectory: string, lastRandomName: string | null): Promise<string> {
    const baseName = lastRandomName ?? this.directoryNameGenerator.generate();
    let suffix = 1;

    while (true) {
      const numberedCandidate = path.join(parentDirectory, `${baseName}-${suffix}`);
      if (!(await this.fsPort.exists(numberedCandidate))) {
        return numberedCandidate;
      }
      suffix += 1;
    }
  }

  // Recursively copies files or directories into the provided destination.
  private async copyEntryRecursive(source: string, destination: string): Promise<void> {
    const stats = await this.fsPort.stat(source);
    if (stats.type === 'directory') {
      await this.fsPort.mkdir(destination, { recursive: true });
      const entries = await this.fsPort.readDir(source);
      for (const entry of entries) {
        const nestedSource = path.join(source, entry.name);
        const nestedDestination = path.join(destination, entry.name);
        await this.copyEntryRecursive(nestedSource, nestedDestination);
      }
    } else {
      await this.fsPort.mkdir(path.dirname(destination), { recursive: true });
      await this.fsPort.copyFile(source, destination);
    }
  }

  // Moves entries using rename or copy-delete fallback as needed.
  private async moveEntry(source: string, destination: string): Promise<void> {
    try {
      await this.fsPort.rename(source, destination);
    } catch {
      await this.copyEntryRecursive(source, destination);
      await this.fsPort.rm(source, { recursive: true, force: true });
    }
  }

  // Executes an operation per source path while accumulating successes/failures.
  private async runOperation(selection: string[], performer: (source: string) => Promise<string>): Promise<OperationResult> {
    const result: OperationResult = { processed: [], failed: [] };

    for (const source of selection) {
      try {
        const processed = await performer(source);
        result.processed.push(processed);
      } catch (error) {
        result.failed.push({ path: source, error });
      }
    }

    return result;
  }
}
