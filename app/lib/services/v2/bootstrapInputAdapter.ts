import type { VerifiedRestaurantData } from '~/types/crawler';
import type { ProjectWithDetails } from '~/types/project';
import { V2BootstrapRequestSchema, type V2BootstrapRequest } from '~/lib/services/v2/contracts';

interface ExtractPayload {
  place_id?: string;
  session_id?: string;
  google_maps_markdown?: string;
  website_markdown?: string;
}

interface AdaptBootstrapInputParams {
  project?: Pick<ProjectWithDetails, 'id' | 'name' | 'business_profile'> | null;
  searchResult?: VerifiedRestaurantData | null;
  extractPayload?: ExtractPayload | null;
  fallback?: {
    businessName?: string;
    businessAddress?: string;
    mapsUrl?: string;
    sessionId?: string;
    placeId?: string;
  };
}

export function adaptBootstrapInput(params: AdaptBootstrapInputParams): V2BootstrapRequest {
  const businessProfile = params.project?.business_profile
    ? {
        ...params.project.business_profile,
      }
    : undefined;

  const candidate: V2BootstrapRequest = {
    projectId: params.project?.id,
    businessName: params.searchResult?.name || params.fallback?.businessName || params.project?.name,
    businessAddress: params.searchResult?.address || params.fallback?.businessAddress,
    mapsUrl: params.fallback?.mapsUrl || businessProfile?.gmaps_url,
    placeId: params.extractPayload?.place_id || params.searchResult?.place_id || params.fallback?.placeId,
    sessionId: params.extractPayload?.session_id || params.fallback?.sessionId || businessProfile?.session_id,
    businessProfile: businessProfile
      ? {
          ...businessProfile,
          place_id: params.extractPayload?.place_id || businessProfile.place_id,
          session_id: params.extractPayload?.session_id || businessProfile.session_id,
          google_maps_markdown: params.extractPayload?.google_maps_markdown || businessProfile.google_maps_markdown,
          website_markdown: params.extractPayload?.website_markdown || businessProfile.website_markdown,
        }
      : params.extractPayload
        ? {
            place_id: params.extractPayload.place_id,
            session_id: params.extractPayload.session_id,
            google_maps_markdown: params.extractPayload.google_maps_markdown,
            website_markdown: params.extractPayload.website_markdown,
          }
        : undefined,
  };

  return V2BootstrapRequestSchema.parse(candidate);
}
