/**
 * Unit Tests for Restaurant Theme Registry
 *
 * Tests the theme registry utility functions to ensure proper
 * theme lookup, prompt retrieval, and data consistency.
 *
 * NOTE: Only 'indochineluxe' theme is currently active in the registry.
 * Other themes are commented out until their zip files are added.
 * Update these tests when more themes are enabled.
 */

import { describe, it, expect } from 'vitest';
import type { RestaurantThemeId } from '~/types/restaurant-theme';
import {
  getThemeById,
  getThemeByTemplateName,
  getThemePrompt,
  getThemeList,
  RESTAURANT_THEMES,
} from '~/theme-prompts/registry';

describe('Restaurant Theme Registry', () => {
  describe('RESTAURANT_THEMES', () => {
    it('should contain active themes', () => {
      expect(RESTAURANT_THEMES.length).toBeGreaterThan(0);
    });

    it('should have unique theme IDs', () => {
      const ids = RESTAURANT_THEMES.map(theme => theme.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(RESTAURANT_THEMES.length);
    });

    it('should have unique template names', () => {
      const templateNames = RESTAURANT_THEMES.map(theme => theme.templateName);
      const uniqueTemplateNames = new Set(templateNames);
      expect(uniqueTemplateNames.size).toBe(RESTAURANT_THEMES.length);
    });

    it('should have valid theme IDs', () => {
      const validIds: RestaurantThemeId[] = [
        'artisanhearthv3',
        'bamboobistro',
        'boldfeastv2',
        'chromaticstreet',
        'classicminimalistv2',
        'dynamicfusion',
        'freshmarket',
        'gastrobotanical',
        'indochineluxe',
        'noirluxev3',
        'saigonveranda',
        'therednoodle',
      ];

      RESTAURANT_THEMES.forEach(theme => {
        expect(validIds).toContain(theme.id);
      });
    });

    it('should have non-empty prompts for all themes', () => {
      RESTAURANT_THEMES.forEach(theme => {
        expect(theme.prompt).toBeDefined();
        expect(typeof theme.prompt).toBe('string');
        expect(theme.prompt.length).toBeGreaterThan(0);
      });
    });

    it('should have required fields for all themes', () => {
      RESTAURANT_THEMES.forEach(theme => {
        expect(theme.id).toBeDefined();
        expect(theme.label).toBeDefined();
        expect(theme.description).toBeDefined();
        expect(theme.cuisines).toBeDefined();
        expect(theme.styleTags).toBeDefined();
        expect(theme.templateName).toBeDefined();
        expect(theme.prompt).toBeDefined();

        expect(Array.isArray(theme.cuisines)).toBe(true);
        expect(Array.isArray(theme.styleTags)).toBe(true);
        expect(theme.cuisines.length).toBeGreaterThan(0);
        expect(theme.styleTags.length).toBeGreaterThan(0);
      });
    });

    it('should include indochineluxe theme', () => {
      const ids = RESTAURANT_THEMES.map(theme => theme.id);
      expect(ids).toContain('indochineluxe');
    });
  });

  describe('getThemeById', () => {
    it('should return correct theme for active ID', () => {
      const theme = getThemeById('indochineluxe');
      expect(theme).toBeDefined();
      expect(theme?.id).toBe('indochineluxe');
      expect(theme?.label).toBe('Indochine Luxe');
      expect(theme?.templateName).toBe('Indochine Luxe');
    });

    it('should return undefined for invalid ID', () => {
      const theme = getThemeById('invalid-id' as RestaurantThemeId);
      expect(theme).toBeUndefined();
    });

    it('should return theme with all expected properties', () => {
      const theme = getThemeById('indochineluxe');
      expect(theme).toBeDefined();
      expect(theme?.id).toBe('indochineluxe');
      expect(typeof theme?.description).toBe('string');
      expect(Array.isArray(theme?.cuisines)).toBe(true);
      expect(Array.isArray(theme?.styleTags)).toBe(true);
      expect(typeof theme?.templateName).toBe('string');
      expect(typeof theme?.prompt).toBe('string');
    });
  });

  describe('getThemeByTemplateName', () => {
    it('should return correct theme for valid template name', () => {
      const theme = getThemeByTemplateName('Indochine Luxe');
      expect(theme).toBeDefined();
      expect(theme?.id).toBe('indochineluxe');
      expect(theme?.templateName).toBe('Indochine Luxe');
    });

    it('should return undefined for invalid template name', () => {
      const theme = getThemeByTemplateName('Invalid Template');
      expect(theme).toBeUndefined();
    });

    it('should be case-sensitive', () => {
      const theme1 = getThemeByTemplateName('Indochine Luxe');
      const theme2 = getThemeByTemplateName('indochine luxe');
      expect(theme1).toBeDefined();
      expect(theme2).toBeUndefined();
    });

    it('should match with active template names', () => {
      RESTAURANT_THEMES.forEach(theme => {
        const found = getThemeByTemplateName(theme.templateName);
        expect(found).toBeDefined();
        expect(found?.templateName).toBe(theme.templateName);
      });
    });
  });

  describe('getThemePrompt', () => {
    it('should return prompt content for valid theme ID', () => {
      const prompt = getThemePrompt('indochineluxe');
      expect(prompt).toBeDefined();
      expect(typeof prompt).toBe('string');
      expect(prompt!.length).toBeGreaterThan(0);
    });

    it('should return null for invalid theme ID', () => {
      const prompt = getThemePrompt('invalid-id' as RestaurantThemeId);
      expect(prompt).toBeNull();
    });

    it('should return prompts with markdown formatting', () => {
      const prompt = getThemePrompt('indochineluxe');
      expect(prompt).toBeDefined();
      expect(typeof prompt).toBe('string');
      // Theme prompts should have markdown headers
      expect(prompt).toMatch(/#+\s*\w+/);
    });
  });

  describe('getThemeList', () => {
    it('should return array with active themes', () => {
      const themeList = getThemeList();
      expect(themeList.length).toBe(RESTAURANT_THEMES.length);
    });

    it('should return array with expected structure', () => {
      const themeList = getThemeList();
      themeList.forEach(theme => {
        expect(theme).toHaveProperty('id');
        expect(theme).toHaveProperty('label');
        expect(theme).toHaveProperty('cuisines');

        expect(typeof theme.id).toBe('string');
        expect(typeof theme.label).toBe('string');
        expect(Array.isArray(theme.cuisines)).toBe(true);
        expect(theme.cuisines.length).toBeGreaterThan(0);
      });
    });

    it('should not include prompt content in list', () => {
      const themeList = getThemeList();
      themeList.forEach(theme => {
        expect(theme).not.toHaveProperty('prompt');
        expect(theme).not.toHaveProperty('description');
        expect(theme).not.toHaveProperty('styleTags');
        expect(theme).not.toHaveProperty('templateName');
      });
    });

    it('should include indochineluxe', () => {
      const themeList = getThemeList();
      const themeIds = themeList.map(theme => theme.id);
      expect(themeIds).toContain('indochineluxe');
    });
  });

  describe('Integration Tests', () => {
    it('should maintain consistency between lookup methods', () => {
      const themeById = getThemeById('indochineluxe');
      const themeByTemplate = getThemeByTemplateName('Indochine Luxe');

      expect(themeById).toBeDefined();
      expect(themeByTemplate).toBeDefined();
      expect(themeById).toEqual(themeByTemplate);
    });

    it('should have matching IDs between registry and list', () => {
      const registryThemeIds = RESTAURANT_THEMES.map(theme => theme.id).sort();
      const listThemeIds = getThemeList().map(theme => theme.id).sort();

      expect(registryThemeIds).toEqual(listThemeIds);
    });
  });
});
