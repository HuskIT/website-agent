/**
 * Unit Tests for FileTree buildFileList
 *
 * Tests the buildFileList function to ensure proper deduplication
 * of file and folder nodes, preventing duplicate React keys.
 */

import { describe, it, expect } from 'vitest';
import { buildFileList, type FileTreeMap } from '~/components/workbench/file-tree-utils';

/**
 * Helper: assert no duplicate fullPath values exist in the list.
 */
function assertNoDuplicatePaths(nodes: Array<{ fullPath: string; kind: string }>) {
  const seen = new Map<string, string>();

  for (const node of nodes) {
    if (seen.has(node.fullPath)) {
      throw new Error(
        `Duplicate fullPath "${node.fullPath}" (kinds: ${seen.get(node.fullPath)}, ${node.kind})`,
      );
    }

    seen.set(node.fullPath, node.kind);
  }
}

describe('buildFileList', () => {
  const ROOT = '/home/project';
  const NO_HIDDEN: Array<string | RegExp> = [];

  describe('basic file tree', () => {
    it('should build a flat list from a simple FileTreeMap', () => {
      const files: FileTreeMap = {
        '/home/project/index.ts': { type: 'file', content: '', isBinary: false },
        '/home/project/package.json': { type: 'file', content: '{}', isBinary: false },
      };

      const result = buildFileList(files, ROOT, true, NO_HIDDEN);

      expect(result.length).toBe(2);
      expect(result.every((n) => n.kind === 'file')).toBe(true);
      assertNoDuplicatePaths(result);
    });

    it('should create intermediate folder nodes from nested paths', () => {
      const files: FileTreeMap = {
        '/home/project/src/index.ts': { type: 'file', content: '', isBinary: false },
      };

      const result = buildFileList(files, ROOT, true, NO_HIDDEN);

      const folder = result.find((n) => n.kind === 'folder' && n.name === 'src');
      const file = result.find((n) => n.kind === 'file' && n.name === 'index.ts');

      expect(folder).toBeDefined();
      expect(file).toBeDefined();
      assertNoDuplicatePaths(result);
    });
  });

  describe('deduplication — no duplicate fullPath values', () => {
    it('should not duplicate folders when explicit folder entries exist alongside files', () => {
      const files: FileTreeMap = {
        '/home/project/src': { type: 'folder' },
        '/home/project/src/styles': { type: 'folder' },
        '/home/project/src/styles/main.css': { type: 'file', content: '', isBinary: false },
      };

      const result = buildFileList(files, ROOT, true, NO_HIDDEN);

      assertNoDuplicatePaths(result);

      const styleFolders = result.filter(
        (n) => n.fullPath === '/home/project/src/styles' && n.kind === 'folder',
      );
      expect(styleFolders.length).toBe(1);
    });

    it('should not duplicate when relative and absolute paths resolve to the same location', () => {
      const files: FileTreeMap = {
        'src/app.tsx': { type: 'file', content: '', isBinary: false },
        '/home/project/src/app.tsx': { type: 'file', content: '', isBinary: false },
      };

      const result = buildFileList(files, ROOT, true, NO_HIDDEN);

      assertNoDuplicatePaths(result);

      const appFiles = result.filter((n) => n.fullPath === '/home/project/src/app.tsx');
      expect(appFiles.length).toBe(1);
    });

    it('should not duplicate folders created by path traversal of different files', () => {
      const files: FileTreeMap = {
        '/home/project/src/components/Button.tsx': { type: 'file', content: '', isBinary: false },
        '/home/project/src/components/Input.tsx': { type: 'file', content: '', isBinary: false },
      };

      const result = buildFileList(files, ROOT, true, NO_HIDDEN);

      assertNoDuplicatePaths(result);

      const srcFolders = result.filter(
        (n) => n.fullPath === '/home/project/src' && n.kind === 'folder',
      );
      expect(srcFolders.length).toBe(1);

      const componentsFolders = result.filter(
        (n) => n.fullPath === '/home/project/src/components' && n.kind === 'folder',
      );
      expect(componentsFolders.length).toBe(1);
    });

    it('should handle snapshot-style FileTreeMap with explicit folder entries and file entries', () => {
      // Simulates the FileTreeMap structure from restoreFromDatabaseSnapshot
      const files: FileTreeMap = {
        src: { type: 'folder' },
        'src/components': { type: 'folder' },
        'src/styles': { type: 'folder' },
        'src/components/App.tsx': { type: 'file', content: '<App />', isBinary: false },
        'src/styles/main.css': { type: 'file', content: 'body{}', isBinary: false },
        'package.json': { type: 'file', content: '{}', isBinary: false },
      };

      const result = buildFileList(files, ROOT, true, NO_HIDDEN);

      assertNoDuplicatePaths(result);

      // Should have: src, src/components, src/styles (folders) + App.tsx, main.css, package.json (files)
      const folders = result.filter((n) => n.kind === 'folder');
      const fileNodes = result.filter((n) => n.kind === 'file');

      expect(folders.length).toBe(3);
      expect(fileNodes.length).toBe(3);
    });

    it('should not produce duplicates when a path exists as both file and folder type', () => {
      // Edge case: corrupt FileTreeMap where same path has both types
      const files: FileTreeMap = {
        '/home/project/src/styles': { type: 'folder' },
        '/home/project/src/styles/main.css': { type: 'file', content: '', isBinary: false },
      };

      // Also add a second entry that would collide (relative path resolving to same absolute)
      (files as any)['src/styles'] = { type: 'folder' };

      const result = buildFileList(files, ROOT, true, NO_HIDDEN);

      assertNoDuplicatePaths(result);
    });
  });

  describe('hidden files', () => {
    it('should exclude files matching hidden patterns', () => {
      const files: FileTreeMap = {
        '/home/project/node_modules/lodash/index.js': {
          type: 'file',
          content: '',
          isBinary: false,
        },
        '/home/project/src/index.ts': { type: 'file', content: '', isBinary: false },
      };

      const result = buildFileList(files, ROOT, true, [/\/node_modules\//]);

      const nodeModules = result.find((n) => n.name === 'node_modules');
      expect(nodeModules).toBeUndefined();

      const srcFile = result.find((n) => n.name === 'index.ts');
      expect(srcFile).toBeDefined();
    });
  });

  describe('rootFolder and hideRoot', () => {
    it('should include root folder node when hideRoot is false and rootFolder is "/"', () => {
      const files: FileTreeMap = {
        '/index.ts': { type: 'file', content: '', isBinary: false },
      };

      const result = buildFileList(files, '/', false, NO_HIDDEN);

      const rootNode = result.find((n) => n.fullPath === '/' && n.kind === 'folder');
      expect(rootNode).toBeDefined();
      assertNoDuplicatePaths(result);
    });

    it('should not include root folder node when hideRoot is true', () => {
      const files: FileTreeMap = {
        '/home/project/index.ts': { type: 'file', content: '', isBinary: false },
      };

      const result = buildFileList(files, ROOT, true, NO_HIDDEN);

      const rootNode = result.find((n) => n.fullPath === ROOT);
      expect(rootNode).toBeUndefined();
    });
  });

  describe('sorting', () => {
    it('should sort folders before files at the same level', () => {
      const files: FileTreeMap = {
        '/home/project/zebra.ts': { type: 'file', content: '', isBinary: false },
        '/home/project/src/index.ts': { type: 'file', content: '', isBinary: false },
        '/home/project/alpha.ts': { type: 'file', content: '', isBinary: false },
      };

      const result = buildFileList(files, ROOT, true, NO_HIDDEN);

      // First entry should be the folder 'src', then files alphabetically
      expect(result[0].kind).toBe('folder');
      expect(result[0].name).toBe('src');
    });

    it('should sort files alphabetically within the same folder', () => {
      const files: FileTreeMap = {
        '/home/project/zebra.ts': { type: 'file', content: '', isBinary: false },
        '/home/project/alpha.ts': { type: 'file', content: '', isBinary: false },
        '/home/project/middle.ts': { type: 'file', content: '', isBinary: false },
      };

      const result = buildFileList(files, ROOT, true, NO_HIDDEN);

      const names = result.map((n) => n.name);
      expect(names).toEqual(['alpha.ts', 'middle.ts', 'zebra.ts']);
    });
  });

  describe('depth calculation', () => {
    it('should assign correct depth values relative to rootFolder', () => {
      const files: FileTreeMap = {
        '/home/project/src/components/Button.tsx': {
          type: 'file',
          content: '',
          isBinary: false,
        },
      };

      const result = buildFileList(files, ROOT, true, NO_HIDDEN);

      const src = result.find((n) => n.name === 'src');
      const components = result.find((n) => n.name === 'components');
      const button = result.find((n) => n.name === 'Button.tsx');

      expect(src?.depth).toBe(0);
      expect(components?.depth).toBe(1);
      expect(button?.depth).toBe(2);
    });
  });

  describe('large FileTreeMap (snapshot-like)', () => {
    it('should handle a realistic snapshot FileTreeMap without duplicates', () => {
      // Simulate a real project restored from snapshot
      const files: FileTreeMap = {
        // Explicit folder entries (created by restoreFromDatabaseSnapshot)
        src: { type: 'folder' },
        'src/components': { type: 'folder' },
        'src/styles': { type: 'folder' },
        'src/lib': { type: 'folder' },
        'src/lib/utils': { type: 'folder' },
        public: { type: 'folder' },
        // File entries
        'package.json': { type: 'file', content: '{}', isBinary: false },
        'tsconfig.json': { type: 'file', content: '{}', isBinary: false },
        'vite.config.ts': { type: 'file', content: '', isBinary: false },
        'src/main.tsx': { type: 'file', content: '', isBinary: false },
        'src/App.tsx': { type: 'file', content: '', isBinary: false },
        'src/components/Header.tsx': { type: 'file', content: '', isBinary: false },
        'src/components/Footer.tsx': { type: 'file', content: '', isBinary: false },
        'src/styles/global.css': { type: 'file', content: '', isBinary: false },
        'src/styles/theme.css': { type: 'file', content: '', isBinary: false },
        'src/lib/utils/cn.ts': { type: 'file', content: '', isBinary: false },
        'public/favicon.ico': { type: 'file', content: '', isBinary: true },
      };

      const result = buildFileList(files, ROOT, true, NO_HIDDEN);

      assertNoDuplicatePaths(result);

      // Verify expected counts
      const folders = result.filter((n) => n.kind === 'folder');
      const fileNodes = result.filter((n) => n.kind === 'file');

      // Folders: src, src/components, src/styles, src/lib, src/lib/utils, public = 6
      expect(folders.length).toBe(6);
      // Files: package.json, tsconfig.json, vite.config.ts, main.tsx, App.tsx,
      //        Header.tsx, Footer.tsx, global.css, theme.css, cn.ts, favicon.ico = 11
      expect(fileNodes.length).toBe(11);
    });
  });
});
