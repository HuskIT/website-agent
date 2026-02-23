import { z } from 'zod';

/*
 * Step 0: V2 contract surface
 * These contracts intentionally accept legacy crawler/business_profile fields
 * so V2 can attach to Flow-A payloads without behavior changes.
 */

export const V2BusinessProfileSchema = z.object({
  place_id: z.string().optional(),
  session_id: z.string().optional(),
  gmaps_url: z.string().optional(),
  crawled_at: z.string().optional(),
  crawled_data: z.unknown().optional(),
  generated_content: z.unknown().optional(),
  google_maps_markdown: z.string().optional(),
  website_markdown: z.string().optional(),
});

export type V2BusinessProfile = z.infer<typeof V2BusinessProfileSchema>;

export const V2BootstrapRequestSchema = z
  .object({
    projectId: z.string().optional(),
    businessName: z.string().min(1).optional(),
    businessAddress: z.string().min(1).optional(),
    mapsUrl: z.string().optional(),
    placeId: z.string().optional(),
    sessionId: z.string().optional(),
    businessProfile: V2BusinessProfileSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const hasNameAddress = Boolean(value.businessName?.trim() && value.businessAddress?.trim());
    const hasBusinessProfile = Boolean(value.businessProfile);
    const hasProjectId = Boolean(value.projectId);

    if (!hasNameAddress && !hasBusinessProfile && !hasProjectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either businessName+businessAddress, businessProfile, or projectId.',
        path: ['businessName'],
      });
    }
  });

export type V2BootstrapRequest = z.infer<typeof V2BootstrapRequestSchema>;

const V2BootstrapEventDataSchema = z.record(z.string(), z.unknown());

export const V2BootstrapSSEEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('input_validated'),
    data: V2BootstrapEventDataSchema,
  }),
  z.object({
    event: z.literal('crawler_started'),
    data: V2BootstrapEventDataSchema,
  }),
  z.object({
    event: z.literal('generation_started'),
    data: V2BootstrapEventDataSchema,
  }),
  z.object({
    event: z.literal('preview_starting'),
    data: V2BootstrapEventDataSchema,
  }),
  z.object({
    event: z.literal('completed'),
    data: V2BootstrapEventDataSchema,
  }),
  z.object({
    event: z.literal('error'),
    data: V2BootstrapEventDataSchema,
  }),
  z.object({
    event: z.literal('heartbeat'),
    data: z.object({ timestamp: z.number() }),
  }),
]);

export type V2BootstrapSSEEvent = z.infer<typeof V2BootstrapSSEEventSchema>;

export const V2GeneratedFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  size: z.number(),
});

export type V2GeneratedFile = z.infer<typeof V2GeneratedFileSchema>;

export const V2BootstrapResponseSchema = z.object({
  success: z.boolean(),
  projectId: z.string(),
  template: z
    .object({
      name: z.string(),
      themeId: z.string().optional(),
      title: z.string().optional(),
      reasoning: z.string().optional(),
    })
    .optional(),
  files: z.array(V2GeneratedFileSchema).default([]),
  snapshot: z
    .object({
      savedAt: z.string(),
      fileCount: z.number(),
      sizeMB: z.number(),
    })
    .nullable()
    .optional(),
  previewUrl: z.string().nullable().optional(),
  timing: z
    .object({
      phase1Ms: z.number(),
      phase2Ms: z.number(),
      totalMs: z.number(),
    })
    .optional(),
  warnings: z.array(z.string()).optional(),
  error: z.string().optional(),
});

export type V2BootstrapResponse = z.infer<typeof V2BootstrapResponseSchema>;

export const V2EditRequestSchema = z.object({
  projectId: z.string().min(1),
  prompt: z.string().min(3).max(4000),
  planId: z.string().optional(),
  previewOnly: z.boolean().optional(),
});

export type V2EditRequest = z.infer<typeof V2EditRequestSchema>;

export const V2EditResponseSchema = z.object({
  success: z.boolean(),
  status: z.enum(['preview', 'approved', 'executing', 'applied', 'failed']),
  projectId: z.string(),
  message: z.string().optional(),
  planId: z.string().optional(),
  previewUrl: z.string().nullable().optional(),
});

export type V2EditResponse = z.infer<typeof V2EditResponseSchema>;
