import { describe, expect, it } from 'vitest';
import {
  buildTemplateSelectionContextPrompt,
  buildTemplateSelectionSystemPrompt,
  composeContentPrompt,
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
    reviews: [{ text: 'Amazing broth and friendly service', author: 'Alex', rating: 5 }],
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

describe('promptPack snapshots', () => {
  it('matches template selection system prompt snapshot', () => {
    expect(buildTemplateSelectionSystemPrompt()).toMatchSnapshot();
  });

  it('matches template selection context prompt snapshot', () => {
    expect(buildTemplateSelectionContextPrompt(legacyProfile as any)).toMatchSnapshot();
  });

  it('matches markdown-first content prompt snapshot', () => {
    expect(composeContentPrompt(markdownProfile as any)).toMatchSnapshot();
  });

  it('matches legacy content prompt snapshot', () => {
    expect(composeContentPrompt(legacyProfile as any)).toMatchSnapshot();
  });
});
