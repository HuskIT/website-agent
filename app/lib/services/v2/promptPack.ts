import { RESTAURANT_THEMES } from '~/theme-prompts/registry';
import type { BusinessProfile } from '~/types/project';
import type {
  BusinessData,
  ColorPalette,
  ContentSections,
  IndustryContext,
  Logo,
  Menu,
  Photo,
  ReputationData,
  Review,
  Typography,
} from '~/types/crawler';

export type PriceTier = 'budget' | 'mid' | 'upscale' | 'luxury';

export interface BusinessProfileAnalysis {
  cuisine: string;
  category: string;
  priceTier: PriceTier;
  style: string;
  keywords: string[];
  rating?: number;
  reviewsCount?: number;
}

export interface ParsedTemplateSelection {
  templateName: string;
  reasoning?: string;
  title?: string;
}

interface MarkdownSelectionSignals {
  inferredName?: string;
  cuisines: string[];
  styleTags: string[];
  menuCategories: string[];
  rating?: number;
  priceTier?: PriceTier;
}

export function buildTemplateSelectionSystemPrompt(): string {
  const themesText = RESTAURANT_THEMES.map((t) => {
    return [
      '<template>',
      `  <name>${t.templateName}</name>`,
      `  <description>${t.description}</description>`,
      `  <cuisines>${t.cuisines.join(', ')}</cuisines>`,
      `  <style>${t.styleTags.join(', ')}</style>`,
      '</template>',
    ].join('\n');
  }).join('\n\n');

  return `
You are selecting the best restaurant website template for a business.

Available Templates:
${themesText}

Select the SINGLE best matching template. Consider (in order):
1. Cuisine alignment (e.g., Vietnamese vs Chinese vs Mediterranean)
2. Price tier / experience (budget, mid, upscale, luxury)
3. Brand style (minimalist, rustic, vibrant, dark-luxe, botanical, etc.)
4. Ambiance keywords (cozy, romantic, modern, energetic, elegant)

Examples (guidance, not strict rules):
- Fine dining + French/luxury → Noir Luxe v3 OR Classic Minimalist v2
- Casual + Asian → Bamboo Bistro OR Indochine Luxe
- Street food + vibrant/urban → Chromatic Street OR The Red Noodle

Response format:
<selection>
  <templateName>{exact template name from list}</templateName>
  <reasoning>{1-2 sentence explanation}</reasoning>
  <title>{a short site title}</title>
</selection>

Important: Provide only the selection tags in your response, no additional text.
`.trim();
}

export function buildTemplateSelectionContextPrompt(profile: BusinessProfile): string {
  const mapsSignals = extractMarkdownSelectionSignals(profile.google_maps_markdown);
  const websiteSignals = extractMarkdownSelectionSignals(profile.website_markdown);
  const analysis = analyzeBusinessProfile(profile);
  const name =
    profile.generated_content?.businessIdentity?.displayName ||
    profile.crawled_data?.name ||
    mapsSignals.inferredName ||
    websiteSignals.inferredName ||
    '';
  const tone = profile.generated_content?.brandStrategy?.toneOfVoice || '';
  const visualStyle = profile.generated_content?.brandStrategy?.visualStyle || '';
  const menuCategoryNames = profile.crawled_data?.menu?.categories?.map((c) => c.name).slice(0, 8) ?? [];
  const menuHints = uniqueStrings([
    ...menuCategoryNames,
    ...mapsSignals.menuCategories,
    ...websiteSignals.menuCategories,
  ]).slice(0, 10);
  const menuHint = menuHints.length ? `- Menu Categories: ${menuHints.join(', ')}` : '';
  const ratingHint = analysis.rating
    ? `- Rating: ${analysis.rating}${analysis.reviewsCount ? ` (${analysis.reviewsCount} reviews)` : ''}`
    : '';
  const markdownCuisineHints = uniqueStrings([...mapsSignals.cuisines, ...websiteSignals.cuisines]).slice(0, 8);
  const markdownStyleHints = uniqueStrings([...mapsSignals.styleTags, ...websiteSignals.styleTags]).slice(0, 8);
  const markdownHintsBlock =
    profile.google_maps_markdown || profile.website_markdown
      ? [
          `- Data Source: markdown-first`,
          markdownCuisineHints.length ? `- Markdown Cuisine Hints: ${markdownCuisineHints.join(', ')}` : null,
          markdownStyleHints.length ? `- Markdown Style Hints: ${markdownStyleHints.join(', ')}` : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n')
      : '- Data Source: legacy-profile';

  const mapsExcerpt = profile.google_maps_markdown ? clampForPrompt(profile.google_maps_markdown, 2000) : '';
  const websiteExcerpt = profile.website_markdown ? clampForPrompt(profile.website_markdown, 1200) : '';

  const markdownBlocks = [
    mapsExcerpt
      ? `<google_maps_markdown_excerpt>
${mapsExcerpt}
</google_maps_markdown_excerpt>`
      : null,
    websiteExcerpt
      ? `<website_markdown_excerpt>
${websiteExcerpt}
</website_markdown_excerpt>`
      : null,
  ]
    .filter((block): block is string => Boolean(block))
    .join('\n\n');

  return `
Business Profile:
- Name: ${name}
- Category: ${analysis.category}
- Cuisine: ${analysis.cuisine}
- Price Tier: ${analysis.priceTier}
- Style: ${analysis.style}
- Keywords: ${analysis.keywords.join(', ')}
- Tone: ${tone}
- Visual Style: ${visualStyle}
${ratingHint}
${menuHint}
${markdownHintsBlock}

${markdownBlocks}
`.trim();
}

export function parseTemplateSelection(llmOutput: string): ParsedTemplateSelection | null {
  const templateNameMatch = llmOutput.match(/<templateName>(.*?)<\/templateName>/);
  const reasoningMatch = llmOutput.match(/<reasoning>(.*?)<\/reasoning>/);
  const titleMatch = llmOutput.match(/<title>(.*?)<\/title>/);

  if (!templateNameMatch) {
    return null;
  }

  return {
    templateName: templateNameMatch[1].trim(),
    reasoning: reasoningMatch?.[1]?.trim(),
    title: titleMatch?.[1]?.trim(),
  };
}

export function composeContentPrompt(businessProfile: BusinessProfile): string {
  /*
   * Theme injection is handled in stream-text.ts via restaurantThemeId.
   * This function only provides business context data.
   */
  const hasMarkdown = !!businessProfile.google_maps_markdown;

  if (hasMarkdown) {
    /*
     * Use markdown content directly (enhanced flow)
     * Theme prompt is not included here by design.
     */
    const hasWebsiteAnalysis = !!businessProfile.website_markdown;

    const websiteAnalysisSection = hasWebsiteAnalysis
      ? `
<existing_website_analysis>
${businessProfile.website_markdown}
</existing_website_analysis>

Use the existing website analysis to match visual style and tone where appropriate.
`
      : '';

    return `
---
BUSINESS PROFILE (REFERENCE DATA)

Use the following data as the primary source of truth for generating website content.

INSTRUCTIONS:
- Extract exact business name, address, phone, hours, and menu items from this data
- Integrate relevant facts naturally into website copy - do NOT paste verbatim
- If details are missing, use sensible defaults without inventing specific claims
- This data takes precedence over any conflicting template placeholders

<google_maps_data>
${businessProfile.google_maps_markdown}
</google_maps_data>
${websiteAnalysisSection}
---

CONTENT REQUIREMENTS:
1. MUST use the exact business name in header, footer, and meta title.
2. MUST use the exact address and phone in the Contact section if provided.
3. MUST use provided hours if available.
4. MUST replace ALL placeholders with business data (no lorem ipsum).
5. MUST generate complete file contents (no TODOs).
6. SHOULD use the website analysis to match visual style if available.

TASK: Generate a complete, production-ready restaurant website using the business information above.
`.trim();
  }

  /*
   * Fall back to legacy formatting (existing projects with crawled_data)
   * Theme prompt is not included here by design.
   */
  const generated = businessProfile.generated_content;
  const crawled = businessProfile.crawled_data;
  const brandStrategy = generated?.brandStrategy;
  const visualAssets = generated?.visualAssets;

  const toneOfVoice = brandStrategy?.toneOfVoice || '';
  const usp = brandStrategy?.usp || '';
  const targetAudience = brandStrategy?.targetAudience || '';
  const visualStyle = brandStrategy?.visualStyle || '';

  const colorPalette = visualAssets?.colorPalette;
  const typography = visualAssets?.typography;

  const formattedBusinessProfile = formatBusinessDataForPrompt(businessProfile);

  const brandVoiceLine = toneOfVoice ? `Write all copy in a "${toneOfVoice}" voice.` : '';
  const uspLine = usp ? `Primary USP: ${usp}` : '';
  const targetAudienceLine = targetAudience ? `Target audience: ${targetAudience}` : '';
  const visualStyleLine = visualStyle ? `Visual style: ${visualStyle}` : '';

  return `
---
BUSINESS PROFILE (REFERENCE DATA)

Use the following data as the primary source of truth for generating website content.

INSTRUCTIONS:
- Extract exact business name, address, phone, hours, and menu items from this data
- Integrate relevant facts naturally into website copy - do NOT paste verbatim
- If details are missing, use sensible defaults without inventing specific claims
- This data takes precedence over any conflicting template placeholders

BRAND VOICE:
${[brandVoiceLine, uspLine, targetAudienceLine, visualStyleLine].filter(Boolean).join('\n') || 'N/A'}

INDUSTRY CONTEXT:
${formatIndustryContextForPrompt(generated?.industryContext)}

REPUTATION & RATINGS:
${formatReputationDataForPrompt(generated?.reputationData, crawled)}

COLOR PALETTE (if provided):
${formatColorPaletteForPrompt(colorPalette)}

TYPOGRAPHY (if provided):
${formatTypographyForPrompt(typography)}

LOGO (if provided):
${formatLogoForPrompt(visualAssets?.logo)}

<business_profile>
${formattedBusinessProfile}
</business_profile>

PRE-GENERATED CONTENT SUGGESTIONS (use as inspiration):
${formatContentSectionsForPrompt(generated?.contentSections)}

<full_business_profile_json>
${JSON.stringify(businessProfile, null, 2)}
</full_business_profile_json>
---

DATA USAGE INSTRUCTIONS:
1. **Photos**: Use REAL image URLs from crawled_data.visual_content.image_collections:
   - food: Use for menu section, hero backgrounds
   - exterior: Use for hero section, about section
   - interior: Use for atmosphere/ambiance section
   - owner_uploads: High-quality official photos, prioritize these

2. **Attributes**: Extract from crawled_data.operational_data.attributes:
   - atmosphere: Use for describing the vibe (e.g., "Casual", "Cozy", "Trendy")
   - offerings: Highlight in about section (e.g., "Vegetarian options", "Happy hour")
   - highlights: Feature prominently (e.g., "Fast service")
   - popular_for: Mention in hero/about (e.g., "Perfect for Lunch, Dinner, Solo dining")
   - accessibility: Include in footer/contact (wheelchair accessible, etc.)

3. **Reviews**: Use crawled_data.reviews_data.top_relevant_reviews:
   - Extract 2-3 compelling quotes for testimonials section
   - Use author_name for attribution
   - Select reviews that highlight different strengths (food quality, service, atmosphere)

4. **Menu**: Use crawled_data.operational_data.menu for complete menu section:
   - Include ALL menu items with actual prices
   - Group logically if categories aren't provided
   - Use exact item names and prices from the data

5. **Business Info**: Use crawled_data.operational_data for accurate details:
   - phone_number: Exact phone number
   - address_formatted: Full address
   - open_hours_raw: Actual operating hours
   - website_url_listed: Link to official website

CONTENT REQUIREMENTS:
1. MUST use the exact business name in header, footer, and meta title.
2. MUST use the exact address and phone in the Contact section if provided.
3. MUST use provided hours if available; otherwise display a sensible default message.
4. MUST replace ALL placeholders in the template with business data (no lorem ipsum).
5. MUST generate complete file contents (no TODOs).
6. SHOULD incorporate the USP into the hero + about copy.
7. SHOULD apply the provided color palette and typography (if present) while respecting the theme layout.
8. SHOULD use the pre-generated content sections as a starting point for copy.
9. SHOULD display rating/reviews count if available (e.g., "4.8★ from 120 reviews").

TASK: Generate a complete, production-ready restaurant website using the business information above.

Include sections: Hero, About, Menu, Contact, Footer.
`.trim();
}

export function analyzeBusinessProfile(profile: BusinessProfile): BusinessProfileAnalysis {
  const mapsSignals = extractMarkdownSelectionSignals(profile.google_maps_markdown);
  const websiteSignals = extractMarkdownSelectionSignals(profile.website_markdown);
  const generated = profile.generated_content;
  const crawled = profile.crawled_data;

  const categories = generated?.industryContext?.categories ?? [];
  const markdownCategories = uniqueStrings([...mapsSignals.cuisines, ...websiteSignals.cuisines]);
  const category = categories[0] ?? markdownCategories[0] ?? 'restaurant';

  const cuisineCandidates = [...categories].map((c) => c.trim().toLowerCase()).filter(Boolean);
  const menuCategories = crawled?.menu?.categories?.map((c) => c.name.trim().toLowerCase()) ?? [];
  const cuisine =
    [...cuisineCandidates, ...menuCategories, ...mapsSignals.cuisines, ...websiteSignals.cuisines][0] ?? category;

  const rating =
    generated?.reputationData?.averageRating ?? crawled?.rating ?? mapsSignals.rating ?? websiteSignals.rating;
  const reviewsCount = generated?.reputationData?.reviewsCount ?? crawled?.reviews_count;

  const pricingTier = generated?.industryContext?.pricingTier?.toLowerCase() ?? '';
  const markdownPriceTier = mapsSignals.priceTier ?? websiteSignals.priceTier;
  const priceTier = markdownPriceTier ?? inferPriceTier({ pricingTier, rating });

  const tone = generated?.brandStrategy?.toneOfVoice?.toLowerCase() ?? '';
  const visualStyle = generated?.brandStrategy?.visualStyle?.toLowerCase() ?? '';

  const reviewText = (crawled?.reviews ?? [])
    .map((r) => r.text)
    .filter(Boolean)
    .slice(0, 10)
    .join(' ')
    .toLowerCase();
  const markdownStyleText = uniqueStrings([...mapsSignals.styleTags, ...websiteSignals.styleTags]).join(' ');

  const inferredStyle = inferStyle({
    category,
    cuisine,
    pricingTier,
    tone,
    visualStyle,
    reviewText: `${reviewText} ${markdownStyleText}`.trim(),
  });

  const keywords = Array.from(
    new Set(
      [
        category,
        cuisine,
        priceTier,
        inferredStyle,
        ...extractStyleKeywords(reviewText),
        ...extractStyleKeywords(`${tone} ${visualStyle}`),
      ]
        .map((k) => k.trim())
        .filter(Boolean),
    ),
  ).slice(0, 12);

  return {
    cuisine,
    category,
    priceTier,
    style: inferredStyle,
    keywords,
    rating: typeof rating === 'number' ? rating : undefined,
    reviewsCount: typeof reviewsCount === 'number' ? reviewsCount : undefined,
  };
}

function extractMarkdownSelectionSignals(markdown: string | undefined): MarkdownSelectionSignals {
  if (!markdown || !markdown.trim()) {
    return {
      cuisines: [],
      styleTags: [],
      menuCategories: [],
    };
  }

  const normalized = markdown.toLowerCase();
  const inferredName = parseNameFromMarkdown(markdown);
  const cuisines = extractKeywordHits(normalized, [
    'vietnamese',
    'thai',
    'chinese',
    'japanese',
    'korean',
    'indian',
    'mexican',
    'mediterranean',
    'french',
    'italian',
    'american',
    'fusion',
    'seafood',
    'bbq',
    'steakhouse',
    'vegetarian',
    'vegan',
    'cafe',
    'bakery',
    'noodle',
    'ramen',
  ]);
  const styleTags = extractKeywordHits(normalized, [
    'luxury',
    'upscale',
    'cozy',
    'casual',
    'modern',
    'minimal',
    'rustic',
    'vibrant',
    'elegant',
    'romantic',
    'dark',
    'bright',
    'botanical',
    'industrial',
  ]);
  const menuCategories = extractMenuCategoriesFromMarkdown(markdown);
  const rating = parseRatingFromMarkdown(markdown);
  const priceTier = parsePriceTierFromMarkdown(normalized);

  return {
    inferredName,
    cuisines,
    styleTags,
    menuCategories,
    rating,
    priceTier,
  };
}

function parseNameFromMarkdown(markdown: string): string | undefined {
  const nameLine = markdown.match(/^\s*[-*]?\s*name\s*:\s*(.+)$/im);

  if (nameLine?.[1]) {
    return nameLine[1].trim();
  }

  const firstHeading = markdown.match(/^\s*#\s+(.+)$/m);

  return firstHeading?.[1]?.trim();
}

function parseRatingFromMarkdown(markdown: string): number | undefined {
  const stars = markdown.match(/([0-5](?:\.\d)?)\s*(?:\/\s*5|stars?|★)/i);

  if (stars?.[1]) {
    const parsed = Number(stars[1]);

    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  const ratingLine = markdown.match(/rating\s*:\s*([0-5](?:\.\d)?)/i);

  if (ratingLine?.[1]) {
    const parsed = Number(ratingLine[1]);

    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function parsePriceTierFromMarkdown(normalizedMarkdown: string): PriceTier | undefined {
  if (normalizedMarkdown.includes('$$$$')) {
    return 'luxury';
  }

  if (normalizedMarkdown.includes('$$$')) {
    return 'upscale';
  }

  if (normalizedMarkdown.includes('$$')) {
    return 'mid';
  }

  if (normalizedMarkdown.includes('$')) {
    return 'budget';
  }

  if (normalizedMarkdown.includes('upscale') || normalizedMarkdown.includes('fine dining')) {
    return 'upscale';
  }

  if (normalizedMarkdown.includes('luxury') || normalizedMarkdown.includes('premium')) {
    return 'luxury';
  }

  if (normalizedMarkdown.includes('budget') || normalizedMarkdown.includes('affordable')) {
    return 'budget';
  }

  return undefined;
}

function extractMenuCategoriesFromMarkdown(markdown: string): string[] {
  const categories = new Set<string>();
  const lines = markdown.split(/\r?\n/);
  const menuAnchorIndex = lines.findIndex((line) => /menu/i.test(line));

  if (menuAnchorIndex >= 0) {
    for (let i = menuAnchorIndex + 1; i < Math.min(lines.length, menuAnchorIndex + 20); i++) {
      const line = lines[i].trim();
      const match = line.match(/^[-*]\s+([A-Za-z][A-Za-z0-9 &/+-]{2,40})\s*:?$/);

      if (match) {
        categories.add(match[1].trim());
      }
    }
  }

  const categoryMatches = markdown.matchAll(/(?:menu\s+category|category)\s*:\s*([^\n,;]+)/gi);

  for (const match of categoryMatches) {
    if (match[1]?.trim()) {
      categories.add(match[1].trim());
    }
  }

  return Array.from(categories).slice(0, 8);
}

function extractKeywordHits(input: string, keywords: string[]): string[] {
  return keywords.filter((keyword) => new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i').test(input));
}

function clampForPrompt(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }

  return `${input.slice(0, maxChars)}\n...[truncated]`;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatBusinessDataForPrompt(profile: BusinessProfile): string {
  const defaults = {
    name: 'Restaurant Name',
    address: '123 Main Street',
    phone: '(555) 123-4567',
    hours: 'Contact us for hours',
  } as const;

  const crawled = profile.crawled_data;
  const generated = profile.generated_content;

  const displayName = generated?.businessIdentity?.displayName || crawled?.name || defaults.name;
  const legalName = generated?.businessIdentity?.legalName || '';
  const tagline = generated?.businessIdentity?.tagline || '';
  const description = generated?.businessIdentity?.description || '';

  const address = crawled?.address || defaults.address;
  const phone = crawled?.phone || defaults.phone;
  const website = crawled?.website || generated?.extractedData?.websiteUrl || '';

  const hoursLines = crawled?.hours
    ? Object.entries(crawled.hours)
        .slice(0, 7)
        .map(([day, value]) => `- ${day}: ${value}`)
        .join('\n')
    : `- ${defaults.hours}`;

  const missingFields: string[] = [];

  if (!generated?.businessIdentity?.displayName && !crawled?.name) {
    missingFields.push('name');
  }

  if (!crawled?.address) {
    missingFields.push('address');
  }

  if (!crawled?.phone) {
    missingFields.push('phone');
  }

  if (!crawled?.hours) {
    missingFields.push('hours');
  }

  const menuText = formatMenuForPrompt(crawled?.menu);
  const reviewsText = formatReviewsForPrompt(crawled?.reviews);
  const photosText = formatPhotosForPrompt(crawled?.photos);

  const defaultsUsedMap: Record<string, string> = {
    name: `name="${defaults.name}"`,
    address: `address="${defaults.address}"`,
    phone: `phone="${defaults.phone}"`,
    hours: `hours="${defaults.hours}"`,
  };

  const defaultsNote =
    missingFields.length > 0
      ? `DEFAULTS USED (because data was missing): ${missingFields.map((f) => defaultsUsedMap[f] ?? f).join(', ')}`
      : 'DEFAULTS USED: none';

  return [
    `BASIC INFO:`,
    `- Display Name: ${displayName}`,
    legalName ? `- Legal Name: ${legalName}` : null,
    tagline ? `- Tagline: ${tagline}` : null,
    description ? `- Description: ${description}` : null,
    '',
    `CONTACT:`,
    `- Address: ${address}`,
    `- Phone: ${phone}`,
    website ? `- Website: ${website}` : null,
    '',
    `HOURS:`,
    hoursLines,
    '',
    defaultsNote,
    '',
    `MENU (if provided):`,
    menuText,
    '',
    `REVIEWS (if provided):`,
    reviewsText,
    '',
    `PHOTOS (if provided):`,
    photosText,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
    .trim();
}

function formatMenuForPrompt(menu: Menu | undefined): string {
  if (!menu?.categories?.length) {
    return 'N/A';
  }

  return menu.categories
    .slice(0, 4)
    .map((category) => {
      const items = (category.items ?? [])
        .slice(0, 6)
        .map((item) => {
          const price = item.price ? ` (${item.price})` : '';
          const desc = item.description ? ` — ${item.description}` : '';

          return `  - ${item.name}${price}${desc}`;
        })
        .join('\n');

      return `- ${category.name}\n${items || '  - N/A'}`;
    })
    .join('\n');
}

function formatReviewsForPrompt(reviews: Review[] | undefined): string {
  if (!reviews?.length) {
    return 'N/A';
  }

  const filtered = reviews
    .filter((r) => typeof r.text === 'string' && r.text.trim().length > 0)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, 5)
    .map((r) => {
      const author = r.author ? ` — ${r.author}` : '';
      const rating = typeof r.rating === 'number' ? ` (${r.rating}/5)` : '';

      return `- "${r.text.trim()}"${author}${rating}`;
    });

  return filtered.length ? filtered.join('\n') : 'N/A';
}

function formatPhotosForPrompt(photos: Photo[] | undefined): string {
  if (!photos?.length) {
    return 'N/A';
  }

  const urls = photos
    .map((p) => p.url)
    .filter((u) => typeof u === 'string' && u.trim().length > 0)
    .slice(0, 6);

  return urls.length ? urls.map((u) => `- ${u}`).join('\n') : 'N/A';
}

function formatColorPaletteForPrompt(palette: ColorPalette | undefined): string {
  if (!palette) {
    return 'N/A';
  }

  const lines = [
    palette.primary ? `- Primary: ${palette.primary} (headers, CTAs, key elements)` : null,
    palette.secondary ? `- Secondary: ${palette.secondary} (accents, borders)` : null,
    palette.accent ? `- Accent: ${palette.accent} (highlights)` : null,
    Array.isArray(palette.background) && palette.background.length
      ? `- Background: ${palette.background.join(', ')}`
      : null,
    Array.isArray(palette.text) && palette.text.length ? `- Text: ${palette.text.join(', ')}` : null,
  ].filter((line): line is string => Boolean(line));

  const text = lines.join('\n').trim();

  return text.length ? text : 'N/A';
}

function formatTypographyForPrompt(typography: Typography | undefined): string {
  if (!typography) {
    return 'N/A';
  }

  const lines = [
    typography.headingFont ? `- Heading font: ${typography.headingFont}` : null,
    typography.bodyFont ? `- Body font: ${typography.bodyFont}` : null,
    Array.isArray(typography.allFonts) && typography.allFonts.length
      ? `- All fonts: ${typography.allFonts.join(', ')}`
      : null,
  ].filter((line): line is string => Boolean(line));

  const text = lines.join('\n').trim();

  return text.length ? text : 'N/A';
}

function formatIndustryContextForPrompt(context: IndustryContext | undefined): string {
  if (!context) {
    return 'N/A';
  }

  const lines = [
    context.categories?.length ? `- Categories: ${context.categories.join(', ')}` : null,
    context.pricingTier ? `- Pricing Tier: ${context.pricingTier}` : null,
    context.operationalHighlights?.length ? `- Highlights: ${context.operationalHighlights.join(', ')}` : null,
  ].filter((line): line is string => Boolean(line));

  return lines.length ? lines.join('\n') : 'N/A';
}

function formatReputationDataForPrompt(
  reputation: ReputationData | undefined,
  crawled: BusinessData | undefined,
): string {
  const rating = reputation?.averageRating ?? crawled?.rating;
  const count = reputation?.reviewsCount ?? crawled?.reviews_count;
  const badges = reputation?.trustBadges;

  const lines = [
    typeof rating === 'number' ? `- Average Rating: ${rating}/5` : null,
    typeof count === 'number' ? `- Total Reviews: ${count}` : null,
    badges?.length ? `- Trust Badges: ${badges.join(', ')}` : null,
  ].filter((line): line is string => Boolean(line));

  return lines.length ? lines.join('\n') : 'N/A';
}

function formatContentSectionsForPrompt(sections: ContentSections | undefined): string {
  if (!sections) {
    return 'N/A';
  }

  const parts: string[] = [];

  if (sections.hero) {
    const heroLines = [`HERO:`, `- Heading: ${sections.hero.heading}`];

    if (sections.hero.subheading) {
      heroLines.push(`- Subheading: ${sections.hero.subheading}`);
    }

    parts.push(heroLines.join('\n'));
  }

  if (sections.about) {
    parts.push(`ABOUT:\n- Heading: ${sections.about.heading}\n- Content: ${sections.about.content}`);
  }

  if (sections.products?.items?.length) {
    const items = sections.products.items
      .slice(0, 6)
      .map((p) => `  - ${p.name}${p.description ? `: ${p.description}` : ''}`)
      .join('\n');
    parts.push(`PRODUCTS:\n- Heading: ${sections.products.heading}\n${items}`);
  }

  return parts.length ? parts.join('\n\n') : 'N/A';
}

function formatLogoForPrompt(logo: Logo | undefined): string {
  if (!logo?.url) {
    return 'N/A';
  }

  const lines = [
    `- URL: ${logo.url}`,
    logo.source ? `- Source: ${logo.source}` : null,
    logo.description ? `- Description: ${logo.description}` : null,
  ].filter((line): line is string => Boolean(line));

  return lines.join('\n');
}

function inferPriceTier(input: { pricingTier: string; rating?: number }): PriceTier {
  const pricing = input.pricingTier;

  if (pricing.includes('$$$$') || pricing.includes('lux') || pricing.includes('premium')) {
    return 'luxury';
  }

  if (pricing.includes('$$$') || pricing.includes('fine') || pricing.includes('upscale')) {
    return 'upscale';
  }

  if (pricing.includes('$$') || pricing.includes('mid')) {
    return 'mid';
  }

  if (pricing.includes('$') || pricing.includes('budget') || pricing.includes('cheap')) {
    return 'budget';
  }

  const rating = input.rating;

  if (typeof rating === 'number') {
    if (rating >= 4.7) {
      return 'upscale';
    }

    if (rating >= 4.3) {
      return 'mid';
    }
  }

  return 'mid';
}

function inferStyle(input: {
  category: string;
  cuisine: string;
  pricingTier: string;
  tone: string;
  visualStyle: string;
  reviewText: string;
}): string {
  const haystack = `${input.category} ${input.cuisine} ${input.pricingTier} ${input.tone} ${input.visualStyle} ${input.reviewText}`;

  if (haystack.includes('street') || haystack.includes('food truck') || haystack.includes('noodle')) {
    return 'vibrant';
  }

  if (haystack.includes('fine dining') || haystack.includes('lux') || haystack.includes('tasting')) {
    return 'elegant';
  }

  if (haystack.includes('botanical') || haystack.includes('garden') || haystack.includes('fresh')) {
    return 'fresh';
  }

  if (haystack.includes('rustic') || haystack.includes('farm') || haystack.includes('hearth')) {
    return 'rustic';
  }

  if (haystack.includes('dark') || haystack.includes('noir') || haystack.includes('gold')) {
    return 'dark-luxe';
  }

  if (haystack.includes('minimal') || haystack.includes('clean') || haystack.includes('scandinavian')) {
    return 'minimalist';
  }

  return 'modern';
}

function extractStyleKeywords(text: string): string[] {
  const candidates = [
    'cozy',
    'romantic',
    'elegant',
    'modern',
    'vibrant',
    'minimal',
    'rustic',
    'luxury',
    'dark',
    'bright',
    'fresh',
    'botanical',
    'industrial',
    'casual',
    'refined',
    'warm',
  ];

  return candidates.filter((w) => text.includes(w));
}
