/**
 * Type validation tests for CrawlRequest
 *
 * Verifies the CrawlRequest interface accepts restaurant_data as an optional field
 * and that a full search-restaurant response can be passed through.
 */

import { describe, it, expect } from 'vitest';
import type { CrawlRequest } from '~/types/crawler';

describe('CrawlRequest type', () => {
  it('accepts restaurant_data field', () => {
    const request: CrawlRequest = {
      session_id: 'test-session',
      business_name: 'Test Restaurant',
      address: '123 Main St',
      restaurant_data: {
        name: 'Test Restaurant',
        place_id: 'ChIJfQfAIgAvdTER2BCqGxIfcNc',
      },
    };

    expect(request.restaurant_data).toBeDefined();
    expect(request.restaurant_data?.name).toBe('Test Restaurant');
  });

  it('works without restaurant_data (optional field)', () => {
    const request: CrawlRequest = {
      session_id: 'test-session',
      business_name: 'Test Restaurant',
      address: '123 Main St',
    };

    expect(request.restaurant_data).toBeUndefined();
  });

  it('accepts a full ~27-field search response as restaurant_data', () => {
    const fullSearchResponse: Record<string, unknown> = {
      name: 'Chạm Bistro Garden',
      place_id: 'ChIJfQfAIgAvdTER2BCqGxIfcNc',
      data_id: '0x3175002f22c00571:0xd770121f1baab10d',
      address: '18A Nguyễn Thị Minh Khai, Đa Kao, Quận 1, HCM',
      phone: '028 3520 3388',
      website: 'http://chambistro.com/',
      coordinates: { latitude: 10.7809752, longitude: 106.6990684, zoom: 14 },
      rating: 4.6,
      reviews_count: 100,
      type: 'Restaurant',
      type_ids: ['restaurant'],
      thumbnail: 'https://lh5.googleusercontent.com/photo.jpg',
      service_options: { dine_in: true, takeout: true, delivery: true },
      extensions: ['$$', 'Casual dining'],
      provider_id: '/g/11t7sby5zw',
      open_state: 'Open ⋅ Closes 10 PM',
      hours: 'Monday, 10 AM to 10 PM|Tuesday, 10 AM to 10 PM',
      booking_link: 'https://booking.example.com',
      menu_link: 'https://menu.example.com',
      data_cid: '12345678901234567890',
      reviews_link: 'https://reviews.example.com',
      photos_link: 'https://photos.example.com',
    };

    const request: CrawlRequest = {
      session_id: 'test-session',
      business_name: 'Chạm Bistro Garden',
      address: '18A Nguyễn Thị Minh Khai',
      place_id: 'ChIJfQfAIgAvdTER2BCqGxIfcNc',
      restaurant_data: fullSearchResponse,
    };

    expect(request.restaurant_data).toBeDefined();
    expect(Object.keys(request.restaurant_data!).length).toBeGreaterThanOrEqual(20);
  });
});
