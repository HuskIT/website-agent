import { describe, expect, it } from 'vitest';
import {
  analyzeBusinessProfile,
  buildTemplateSelectionContextPrompt,
  buildTemplateSelectionSystemPrompt,
  composeContentPrompt,
  parseTemplateSelection,
} from '~/lib/services/v2/promptPack';

const legacyProfile = {
  crawled_data: {
    name: 'Pho Nova',
    address: '123 Main St, San Jose, CA',
    phone: '(408) 555-0101',
    hours: {
      monday: '9:00 AM - 9:00 PM',
      tuesday: '9:00 AM - 9:00 PM',
    },
    rating: 4.7,
    reviews_count: 128,
    menu: {
      categories: [
        {
          name: 'Pho',
          items: [
            { name: 'Pho Dac Biet', price: '$16.99', description: 'House special beef noodle soup' },
            { name: 'Pho Ga', price: '$15.99' },
          ],
        },
      ],
    },
    reviews: [
      { text: 'Amazing broth and friendly service', author: 'Alex', rating: 5 },
      { text: 'Fresh herbs and generous portions', author: 'Jamie', rating: 4.8 },
    ],
    photos: [{ url: 'https://cdn.example.com/pho-1.jpg' }],
  },
  generated_content: {
    businessIdentity: {
      displayName: 'Pho Nova',
      tagline: 'Soulful bowls every day',
    },
    brandStrategy: {
      toneOfVoice: 'warm and welcoming',
      usp: 'Slow-simmered broth for 16 hours',
      targetAudience: 'Families and office workers',
      visualStyle: 'modern minimal',
    },
    industryContext: {
      categories: ['Vietnamese', 'Noodle shop'],
      pricingTier: '$$',
      operationalHighlights: ['Takeout', 'Dine-in'],
    },
    reputationData: {
      averageRating: 4.7,
      reviewsCount: 128,
      trustBadges: ['Top Rated'],
    },
  },
};

const markdownProfile = {
  google_maps_markdown: '# Google Maps\n\n- Name: Pho Nova\n- Address: 123 Main St',
  website_markdown: '# Existing Website\n\nCurrent site is clean and modern.',
};

const markdownOnlyProfile = {
  google_maps_markdown: `
# Lotus Garden

- Name: Lotus Garden
- Cuisine: Vietnamese
- Price: $$
- Rating: 4.6/5

## Menu
- Pho
- Vermicelli
`.trim(),
};

describe('promptPack', () => {
  it('builds the template selection system prompt with strict selection tags', () => {
    const prompt = buildTemplateSelectionSystemPrompt();

    expect(prompt).toContain('You are selecting the best restaurant website template');
    expect(prompt).toContain('<template>');
    expect(prompt).toContain('<selection>');
    expect(prompt).toContain('<templateName>{exact template name from list}</templateName>');
  });

  it('builds a template selection context prompt from business profile', () => {
    const prompt = buildTemplateSelectionContextPrompt(legacyProfile as any);

    expect(prompt).toContain('- Name: Pho Nova');
    expect(prompt).toContain('- Cuisine: vietnamese');
    expect(prompt).toContain('- Price Tier: mid');
    expect(prompt).toContain('- Rating: 4.7 (128 reviews)');
    expect(prompt).toContain('- Menu Categories: Pho');
    expect(prompt).toContain('- Data Source: legacy-profile');
  });

  it('builds markdown-aware selection context when only markdown exists', () => {
    const prompt = buildTemplateSelectionContextPrompt(markdownOnlyProfile as any);

    expect(prompt).toContain('- Name: Lotus Garden');
    expect(prompt).toContain('- Data Source: markdown-first');
    expect(prompt).toContain('- Markdown Cuisine Hints: vietnamese');
    expect(prompt).toContain('- Menu Categories: Pho, Vermicelli');
    expect(prompt).toContain('<google_maps_markdown_excerpt>');
  });

  it('parses selection tags and returns structured data', () => {
    const parsed = parseTemplateSelection(`
<selection>
  <templateName>Bamboo Bistro</templateName>
  <reasoning>Vietnamese cuisine and warm tone align strongly.</reasoning>
  <title>Pho Nova</title>
</selection>
`);

    expect(parsed).toEqual({
      templateName: 'Bamboo Bistro',
      reasoning: 'Vietnamese cuisine and warm tone align strongly.',
      title: 'Pho Nova',
    });
  });

  it('returns null when templateName tag is missing', () => {
    const parsed = parseTemplateSelection('<selection><reasoning>test</reasoning></selection>');

    expect(parsed).toBeNull();
  });

  it('composes markdown-first content prompt when markdown inputs exist', () => {
    const prompt = composeContentPrompt(markdownProfile as any);

    expect(prompt).toContain('<google_maps_data>');
    expect(prompt).toContain('# Google Maps');
    expect(prompt).toContain('<existing_website_analysis>');
    expect(prompt).toContain('Use the existing website analysis to match visual style and tone where appropriate.');
  });

  it('composes legacy content prompt with business data sections', () => {
    const prompt = composeContentPrompt(legacyProfile as any);

    expect(prompt).toContain('BRAND VOICE:');
    expect(prompt).toContain('Write all copy in a "warm and welcoming" voice.');
    expect(prompt).toContain('MENU (if provided):');
    expect(prompt).toContain('Pho Dac Biet');
    expect(prompt).toContain('REPUTATION & RATINGS:');
  });

  it('analyzes business profile to produce stable selection features', () => {
    const analysis = analyzeBusinessProfile(legacyProfile as any);

    expect(analysis.category).toBe('Vietnamese');
    expect(analysis.cuisine).toBe('vietnamese');
    expect(analysis.priceTier).toBe('mid');
    expect(analysis.rating).toBe(4.7);
    expect(analysis.reviewsCount).toBe(128);
  });

  it('uses markdown signals for analysis when legacy data is missing', () => {
    const analysis = analyzeBusinessProfile(markdownOnlyProfile as any);

    expect(analysis.category).toBe('vietnamese');
    expect(analysis.cuisine).toBe('vietnamese');
    expect(analysis.priceTier).toBe('mid');
    expect(analysis.rating).toBe(4.6);
  });
});
