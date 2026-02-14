import { describe, it, expect } from 'vitest';
import { validateContentGeneration } from './contentGenerationValidator';
import type { GeneratedFile } from '~/types/generation';

describe('contentGenerationValidator', () => {
  describe('validateContentGeneration', () => {
    it('should pass when only content.ts is generated', () => {
      const files: GeneratedFile[] = [
        {
          path: 'src/data/content.ts',
          content: 'export const businessData = { name: "Test" };',
          size: 100,
        },
      ];

      const result = validateContentGeneration(files);

      expect(result.valid).toBe(true);
      expect(result.filesDetected).toEqual(['src/data/content.ts']);
      expect(result.reason).toBeUndefined();
    });

    it('should handle path variations correctly', () => {
      const pathVariations = [
        'src/data/content.ts',
        '/src/data/content.ts',
        'data/content.ts',
        '/home/project/src/data/content.ts', // Absolute workspace path
        'src/home/project/src/data/content.ts', // Workspace prefix
        'content.ts', // Just filename
      ];

      for (const path of pathVariations) {
        const files: GeneratedFile[] = [{ path, content: 'export const businessData = {};', size: 100 }];

        const result = validateContentGeneration(files);

        expect(result.valid).toBe(true);
        expect(result.filesDetected).toEqual([path]);
      }
    });

    it('should fail when no files are generated', () => {
      const result = validateContentGeneration([]);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('No files were generated');
      expect(result.filesDetected).toEqual([]);
    });

    it('should fail when wrong file is generated', () => {
      const files: GeneratedFile[] = [{ path: 'src/App.tsx', content: 'import React from "react";', size: 100 }];

      const result = validateContentGeneration(files);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Expected content.ts');
      expect(result.reason).toContain('got App.tsx');
      expect(result.filesDetected).toEqual(['src/App.tsx']);
    });

    it('should fail when multiple files are generated', () => {
      const files: GeneratedFile[] = [
        { path: 'src/data/content.ts', content: '...', size: 100 },
        { path: 'src/App.tsx', content: '...', size: 100 },
        { path: 'src/components/Hero.tsx', content: '...', size: 100 },
      ];

      const result = validateContentGeneration(files);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('3 files were generated');
      expect(result.filesDetected).toHaveLength(3);
      expect(result.filesDetected).toContain('src/data/content.ts');
      expect(result.filesDetected).toContain('src/App.tsx');
      expect(result.filesDetected).toContain('src/components/Hero.tsx');
    });

    it('should fail when content.ts is generated alongside other files', () => {
      const files: GeneratedFile[] = [
        { path: 'src/data/content.ts', content: 'export const businessData = {};', size: 100 },
        { path: 'package.json', content: '{ "name": "test" }', size: 100 },
      ];

      const result = validateContentGeneration(files);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('2 files were generated');
    });

    it('should handle edge case: empty file path', () => {
      const files: GeneratedFile[] = [{ path: '', content: '...', size: 100 }];

      const result = validateContentGeneration(files);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Expected content.ts');
    });

    it('should fail when many files are generated (realistic LLM failure)', () => {
      // Simulate LLM generating a full template instead of just content.ts
      const files: GeneratedFile[] = [
        { path: 'src/data/content.ts', content: 'export const data = {};', size: 100 },
        { path: 'src/App.tsx', content: 'import React from "react";', size: 200 },
        { path: 'src/components/Header.tsx', content: 'export const Header = ...', size: 150 },
        { path: 'src/components/Footer.tsx', content: 'export const Footer = ...', size: 150 },
        { path: 'src/components/Hero.tsx', content: 'export const Hero = ...', size: 180 },
        { path: 'src/styles/main.css', content: 'body { margin: 0; }', size: 100 },
        { path: 'package.json', content: '{ "name": "app" }', size: 50 },
        { path: 'index.html', content: '<!DOCTYPE html>', size: 80 },
        { path: 'vite.config.ts', content: 'export default {}', size: 60 },
        { path: 'tsconfig.json', content: '{ "compilerOptions": {} }', size: 70 },
      ];

      const result = validateContentGeneration(files);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('10 files were generated');
      expect(result.filesDetected).toHaveLength(10);
      expect(result.filesDetected).toContain('src/data/content.ts');
      expect(result.filesDetected).toContain('src/App.tsx');
    });
  });
});
