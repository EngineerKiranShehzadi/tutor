import { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { getPlaylistMetadata, validPlaylistId } from './youtube-discovery.service';

export interface SavedPlaylist {
  playlist_id: string;
  title: string;
  channel_title: string;
  thumbnail_url: string | null;
  created_at: Date;
}
export const MAX_SAVED_PLAYLISTS = 20;

export async function listSavedPlaylists(userId: string): Promise<SavedPlaylist[]> {
  const { rows } = await query<SavedPlaylist>(
    'SELECT playlist_id,title,channel_title,thumbnail_url,created_at FROM student_saved_playlists WHERE user_id=$1 ORDER BY created_at DESC,playlist_id',
    [userId]
  );
  return rows;
}

export async function savePlaylist(userId: string, playlistId: string): Promise<SavedPlaylist> {
  if (!validPlaylistId(playlistId)) throw new AppError('Invalid playlist ID', 400);
  // Fetch authoritative metadata; never store arbitrary client-supplied HTML/URLs.
  const metadata = await getPlaylistMetadata(playlistId);
  // Atomically enforce the per-user limit, even when multiple save requests race.
  const { rows } = await query<SavedPlaylist>(
    `WITH locked AS (
      SELECT id FROM users WHERE id=$1 FOR UPDATE
    ), inserted AS (
      INSERT INTO student_saved_playlists(user_id,playlist_id,title,channel_title,thumbnail_url)
      SELECT $1,$2,$3,$4,$5 FROM locked
      WHERE (SELECT COUNT(*) FROM student_saved_playlists WHERE user_id=$1) < $6
         OR EXISTS (SELECT 1 FROM student_saved_playlists WHERE user_id=$1 AND playlist_id=$2)
      ON CONFLICT(user_id,playlist_id) DO UPDATE SET
        title=EXCLUDED.title,channel_title=EXCLUDED.channel_title,thumbnail_url=EXCLUDED.thumbnail_url
      RETURNING playlist_id,title,channel_title,thumbnail_url,created_at
    ) SELECT * FROM inserted`,
    [userId, playlistId, metadata.title, metadata.channelTitle, metadata.thumbnail, MAX_SAVED_PLAYLISTS]
  );
  if (!rows[0]) throw new AppError('Saved playlist limit reached', 409);
  return rows[0];
}

export async function removeSavedPlaylist(userId: string, playlistId: string): Promise<void> {
  if (!validPlaylistId(playlistId)) throw new AppError('Invalid playlist ID', 400);
  const { rowCount } = await query(
    'DELETE FROM student_saved_playlists WHERE user_id=$1 AND playlist_id=$2',
    [userId, playlistId]
  );
  if (!rowCount) throw new AppError('Saved playlist not found', 404);
}
