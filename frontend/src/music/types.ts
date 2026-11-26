/** Shapes returned by `/api/music/*` (see backend/src/music/service.ts). */

export interface Ref {
  id: number;
  name: string;
}

export interface Track {
  id: number;
  title: string;
  artist: Ref;
  /** Full credit as tagged ("A feat. B"). */
  artistName: string;
  album: { id: number; title: string };
  duration: number | null;
  trackNumber: number | null;
  discNumber: number | null;
  year: number | null;
  art: string | null;
  /** MIME type with codecs for canPlayType; null when browsers can't play it. */
  mime: string | null;
  liked: boolean;
}

export interface Album {
  id: number;
  title: string;
  artist: Ref;
  year: number | null;
  art: string | null;
  genres: string[];
  trackCount: number;
  duration: number;
  kind: 'album' | 'single' | 'ep';
  single: boolean;
  addedAt: string;
}

export interface Artist {
  id: number;
  name: string;
  art: string | null;
  albumCount: number;
  trackCount: number;
}

export interface Playlist {
  id: number;
  name: string;
  description: string | null;
  trackCount: number;
  duration: number;
  arts: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Mix {
  id: string;
  title: string;
  subtitle: string;
  arts: string[];
}

export type ListenAgainItem =
  | { type: 'album'; album: Album }
  | { type: 'artist'; artist: Artist }
  | { type: 'playlist'; playlist: Playlist };

export interface HomeData {
  empty: boolean;
  genres: string[];
  quickPicks: Track[];
  listenAgain: ListenAgainItem[];
  mixes: Mix[];
  recentlyAdded: Album[];
  favoriteArtists: Artist[];
  albumsForYou: Album[];
}

export interface ExploreData {
  genres: Array<{ name: string; count: number }>;
  newAlbums: Album[];
  topSongs: Track[];
  artists: Artist[];
}

export interface AlbumPage {
  album: Album;
  tracks: Track[];
  moreByArtist: Album[];
}

export interface ArtistPage {
  artist: Artist;
  topSongs: Track[];
  albums: Album[];
  singles: Album[];
  appearsOn: Album[];
  related: Artist[];
}

export interface PlaylistPage {
  playlist: Playlist;
  entries: Array<{ entryId: number; track: Track }>;
}

export interface SearchResults {
  top: { type: 'artist'; artist: Artist } | { type: 'album'; album: Album } | { type: 'song'; track: Track } | null;
  songs: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: Playlist[];
}

export interface Lyrics {
  synced: Array<{ time: number; text: string }> | null;
  plain: string;
  source: 'lrc' | 'embedded';
}

export interface RelatedData {
  tracks: Track[];
  artists: Artist[];
  albums: Album[];
}
