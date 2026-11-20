import { describe, expect, it } from 'vitest';
import { sanitizeVideos } from '../../../backend/src/plugins/services/sanitize.js';
import { mapVideos } from '../mapper.js';
import type { TmdbVideo } from '../types.js';

const video = (over: Partial<TmdbVideo>): TmdbVideo => ({ id: over.key ?? 'id', key: 'k', site: 'YouTube', type: 'Trailer', ...over });

describe('mapVideos', () => {
  it('ranks trailers by type, language, official flag, size and date', () => {
    const ranked = mapVideos(
      [
        video({ key: 'teaser-en', type: 'Teaser', iso_639_1: 'en', official: true }),
        video({ key: 'trailer-fr', iso_639_1: 'fr', official: true }),
        video({ key: 'trailer-en-fan', iso_639_1: 'en', official: false, size: 1080 }),
        video({ key: 'trailer-en-old', iso_639_1: 'en', official: true, size: 1080, published_at: '2024-01-01T00:00:00Z' }),
        video({ key: 'trailer-en-new', iso_639_1: 'en', official: true, size: 1080, published_at: '2025-01-01T00:00:00Z' }),
        video({ key: 'trailer-en-720', iso_639_1: 'en', official: true, size: 720 }),
      ],
      'en',
    );
    expect(ranked.map((v) => v.key)).toEqual(['trailer-en-new', 'trailer-en-old', 'trailer-en-720', 'trailer-en-fan', 'trailer-fr', 'teaser-en']);
    expect(ranked[0]).toMatchObject({ site: 'youtube', type: 'trailer', official: true, language: 'en' });
  });

  it('prefers the library language over English, and drops unknown sites', () => {
    const ranked = mapVideos(
      [video({ key: 'en', iso_639_1: 'en' }), video({ key: 'de', iso_639_1: 'de' }), video({ key: 'x', site: 'Dailymotion' })],
      'de',
    );
    expect(ranked.map((v) => v.key)).toEqual(['de', 'en']);
  });
});

describe('sanitizeVideos', () => {
  it('keeps known sites and embed-safe ids only', () => {
    expect(
      sanitizeVideos([
        { site: 'YouTube', key: 'abc_DEF-123', type: 'trailer', name: ' Official ' },
        { site: 'youtube', key: 'bad/../id', type: 'trailer' },
        { site: 'evil', key: 'abc', type: 'trailer' },
        { site: 'vimeo', key: '76979871', type: 'weird' },
        'nope',
      ]),
    ).toEqual([
      { site: 'youtube', key: 'abc_DEF-123', type: 'trailer', name: 'Official', language: undefined, official: undefined, publishedAt: undefined },
      { site: 'vimeo', key: '76979871', type: 'other', name: undefined, language: undefined, official: undefined, publishedAt: undefined },
    ]);
  });
});
