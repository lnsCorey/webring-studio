import React, { useState } from 'react';
import { ArrowLeft, Camera, Heart, Plus, Share2, Trash2 } from 'lucide-react';
import {
  AlbumDisplay,
  CompleteSiteBundle,
  EndorsementItem,
  PhotoItem,
  albumDisplay,
  albumIsPosted,
  isPlaceholderSiteUrl,
} from '../shared/schema';

type StudioAlbum = CompleteSiteBundle['albums']['albums'][number];
import { MarkdownField } from './MarkdownField';
import { StudioViewMode, ViewModeToggle, loadViewMode, saveViewMode } from './ViewModeToggle';
import { albumEngagementCounts, photoEngagementCounts } from './studioFilters';

export interface AlbumDraftState {
  title: string;
  description: string;
  tags: string;
  postToFeed: boolean;
  display: AlbumDisplay;
}

export interface MediaLibraryViewProps {
  albums: StudioAlbum[];
  siteUrl: string;
  lastPublishedAt?: string;
  endorsements: EndorsementItem[];
  mediaUsage: { files: number; bytes: number } | null;
  selectedAlbumId: string | null;
  setSelectedAlbumId: (id: string | null) => void;
  albumDraft: AlbumDraftState | null;
  setAlbumDraft: (draft: AlbumDraftState | null) => void;
  newAlbumTitle: string;
  setNewAlbumTitle: (v: string) => void;
  newAlbumDesc: string;
  setNewAlbumDesc: (v: string) => void;
  newAlbumPostToFeed: boolean;
  setNewAlbumPostToFeed: (v: boolean) => void;
  newAlbumDisplay: AlbumDisplay;
  setNewAlbumDisplay: (v: AlbumDisplay) => void;
  handleCreateAlbum: (e: React.FormEvent) => void;
  handleSaveAlbum: () => void;
  handleDeleteAlbum: (album: StudioAlbum) => void;
  isImportingPhotos: boolean;
  isDraggingPhotos: boolean;
  setIsDraggingPhotos: (v: boolean) => void;
  handleImportPhotos: () => void;
  handleDropPhotos: (e: React.DragEvent) => void;
  photoDrafts: Record<string, { caption: string; altText: string }>;
  setPhotoDrafts: React.Dispatch<React.SetStateAction<Record<string, { caption: string; altText: string }>>>;
  handleSavePhotoDetails: (photoId: string) => void;
  handlePhotoAction: (photo: PhotoItem, action: 'up' | 'down' | 'cover' | 'replace' | 'delete') => void;
  newPhotoUrl: string;
  setNewPhotoUrl: (v: string) => void;
  newPhotoCaption: string;
  setNewPhotoCaption: (v: string) => void;
  handleAddPhoto: (e: React.FormEvent) => void;
  handleForgetPublishHistory: () => void;
  refreshMediaUsage: () => void;
  mediaSrc: (url: string) => string;
  formatBytes: (bytes: number) => string;
  formatRelativeTime: (iso: string) => string;
}

function formatShortDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function MediaLibraryView(props: MediaLibraryViewProps) {
  const {
    albums,
    siteUrl,
    lastPublishedAt,
    endorsements,
    mediaUsage,
    selectedAlbumId,
    setSelectedAlbumId,
    albumDraft,
    setAlbumDraft,
    newAlbumTitle,
    setNewAlbumTitle,
    newAlbumDesc,
    setNewAlbumDesc,
    newAlbumPostToFeed,
    setNewAlbumPostToFeed,
    newAlbumDisplay,
    setNewAlbumDisplay,
    handleCreateAlbum,
    handleSaveAlbum,
    handleDeleteAlbum,
    isImportingPhotos,
    isDraggingPhotos,
    setIsDraggingPhotos,
    handleImportPhotos,
    handleDropPhotos,
    photoDrafts,
    setPhotoDrafts,
    handleSavePhotoDetails,
    handlePhotoAction,
    newPhotoUrl,
    setNewPhotoUrl,
    newPhotoCaption,
    setNewPhotoCaption,
    handleAddPhoto,
    handleForgetPublishHistory,
    refreshMediaUsage,
    mediaSrc,
    formatBytes,
    formatRelativeTime,
  } = props;

  const [albumsViewMode, setAlbumsViewMode] = useState<StudioViewMode>(() =>
    loadViewMode('studio-media-albums-view', 'cards')
  );
  const [photosViewMode, setPhotosViewMode] = useState<StudioViewMode>(() =>
    loadViewMode('studio-media-photos-view', 'cards')
  );
  const [showNewAlbumForm, setShowNewAlbumForm] = useState(albums.length === 0);

  const setAlbumsMode = (m: StudioViewMode) => {
    setAlbumsViewMode(m);
    saveViewMode('studio-media-albums-view', m);
  };
  const setPhotosMode = (m: StudioViewMode) => {
    setPhotosViewMode(m);
    saveViewMode('studio-media-photos-view', m);
  };

  const selectedAlbum = selectedAlbumId ? albums.find((a) => a.id === selectedAlbumId) || null : null;

  // =========================================================================
  // ALBUM DETAIL VIEW
  // =========================================================================
  if (selectedAlbum) {
    const draft: AlbumDraftState = albumDraft || {
      title: selectedAlbum.title,
      description: selectedAlbum.description,
      tags: selectedAlbum.tags.join(', '),
      postToFeed: albumIsPosted(selectedAlbum),
      display: albumDisplay(selectedAlbum),
    };
    const albumStats = albumEngagementCounts(selectedAlbum, siteUrl, endorsements);
    const coverPreview = selectedAlbum.coverUrl || selectedAlbum.photos[0]?.thumbUrl || selectedAlbum.photos[0]?.url || '';

    return (
      <div className="max-w-6xl mx-auto space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => {
              setSelectedAlbumId(null);
              setAlbumDraft(null);
            }}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-semibold text-slate-200 transition"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Media Library
          </button>

          <div className="flex flex-wrap items-center gap-2">
            <ViewModeToggle mode={photosViewMode} onChange={setPhotosMode} ariaLabel="Album photos view mode" />
            <button
              type="button"
              onClick={() => handleDeleteAlbum(selectedAlbum)}
              className="px-3 py-1.5 rounded-xl bg-rose-950/40 hover:bg-rose-900/50 border border-rose-500/30 text-rose-300 text-xs font-semibold inline-flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete Album
            </button>
          </div>
        </div>

        {/* Album Summary & Metadata Header */}
        <div
          className={`bg-slate-900 border rounded-2xl p-5 space-y-4 transition ${
            isDraggingPhotos ? 'border-indigo-400 bg-indigo-950/20' : 'border-slate-800'
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDraggingPhotos(true);
          }}
          onDragLeave={() => setIsDraggingPhotos(false)}
          onDrop={handleDropPhotos}
        >
          <div className="flex flex-col md:flex-row gap-5">
            <div className="w-full md:w-48 shrink-0">
              {coverPreview ? (
                <img
                  src={mediaSrc(coverPreview)}
                  alt={selectedAlbum.title}
                  className="w-full aspect-[4/3] rounded-xl object-cover bg-slate-950 border border-slate-800"
                />
              ) : (
                <div className="w-full aspect-[4/3] rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-center">
                  <Camera className="w-8 h-8 text-slate-600" />
                </div>
              )}
              <div className="mt-2.5 grid grid-cols-3 gap-1.5 text-center">
                <div className="p-1.5 rounded-lg bg-slate-950 border border-slate-800">
                  <div className="text-xs font-bold text-white">{selectedAlbum.photos.length}</div>
                  <div className="text-[10px] text-slate-500">Items</div>
                </div>
                <div className="p-1.5 rounded-lg bg-slate-950 border border-slate-800">
                  <div className="text-xs font-bold text-pink-300">{albumStats.likes}</div>
                  <div className="text-[10px] text-slate-500">Likes</div>
                </div>
                <div className="p-1.5 rounded-lg bg-slate-950 border border-slate-800">
                  <div className="text-xs font-bold text-sky-300">{albumStats.shares}</div>
                  <div className="text-[10px] text-slate-500">Shares</div>
                </div>
              </div>
              <div className="mt-2 text-[11px] text-slate-500 space-y-0.5">
                <div>Created: {formatShortDate(selectedAlbum.createdAt)}</div>
                <div>Updated: {formatShortDate(selectedAlbum.updatedAt)}</div>
              </div>
            </div>

            <div className="flex-1 min-w-0 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <input
                  type="text"
                  value={draft.title}
                  onChange={(e) => setAlbumDraft({ ...draft, title: e.target.value })}
                  className="px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-semibold"
                />
                <input
                  type="text"
                  value={draft.tags}
                  onChange={(e) => setAlbumDraft({ ...draft, tags: e.target.value })}
                  placeholder="Tags, comma separated"
                  className="px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                />
                <MarkdownField
                  value={draft.description}
                  onChange={(description) => setAlbumDraft({ ...draft, description })}
                  placeholder="Description (Markdown: headings, links, lists, tables)"
                  className="md:col-span-2"
                />
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-400">
                <label className="flex items-center gap-1.5 cursor-pointer text-slate-300">
                  <input
                    type="checkbox"
                    checked={draft.postToFeed}
                    onChange={(e) => setAlbumDraft({ ...draft, postToFeed: e.target.checked })}
                  />
                  Post to feed
                </label>
                <div className="flex items-center gap-2 text-slate-300">
                  <span>Show on site as:</span>
                  {(['card', 'expanded'] as AlbumDisplay[]).map((mode) => (
                    <label key={mode} className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="radio"
                        name="album-display"
                        checked={draft.display === mode}
                        onChange={() => setAlbumDraft({ ...draft, display: mode })}
                      />
                      {mode === 'card' ? 'Card' : 'Expanded'}
                    </label>
                  ))}
                </div>
                <span className="text-slate-500">
                  Page: <code className="text-slate-300">{selectedAlbum.pageUrl}</code>
                  {lastPublishedAt && !isPlaceholderSiteUrl(siteUrl) && (
                    <button
                      type="button"
                      onClick={() =>
                        window.studioApi?.openExternal(
                          `${siteUrl.replace(/\/+$/, '')}/${selectedAlbum.pageUrl}`
                        )
                      }
                      className="ml-2 text-indigo-400 hover:text-indigo-300"
                    >
                      View page ↗
                    </button>
                  )}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                {albumDraft && (
                  <button
                    type="button"
                    onClick={handleSaveAlbum}
                    className="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold"
                  >
                    Save Album
                  </button>
                )}
                <button
                  type="button"
                  disabled={isImportingPhotos}
                  onClick={() => handleImportPhotos()}
                  className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {isImportingPhotos ? 'Importing…' : 'Add Photos'}
                </button>
                <span className="text-xs text-slate-500">or drop JPEG/PNG files here</span>
              </div>
            </div>
          </div>

          {/* Individual Album Media Items (Card View or List View) */}
          <div className="border-t border-slate-800 pt-4">
            {selectedAlbum.photos.length === 0 ? (
              <p className="text-sm text-slate-500 py-10 text-center">
                No media items in this album yet. Click <strong>Add Photos</strong> or drop images here.
              </p>
            ) : photosViewMode === 'cards' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {selectedAlbum.photos.map((photo, idx) => {
                  const photoDraft = photoDrafts[photo.id] || { caption: photo.caption, altText: photo.altText };
                  const isCover = selectedAlbum.coverUrl === photo.thumbUrl;
                  const pStats = photoEngagementCounts(photo, siteUrl, endorsements);
                  return (
                    <div key={photo.id} className="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden flex flex-col">
                      <div className="relative">
                        <img
                          src={mediaSrc(photo.thumbUrl || photo.url)}
                          alt={photo.altText}
                          className="w-full aspect-[4/3] object-cover bg-slate-800"
                        />
                        {isCover && (
                          <span className="absolute top-2 left-2 text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-600/90 text-white">
                            Cover
                          </span>
                        )}
                      </div>
                      <div className="p-2.5 space-y-1.5 flex-1 flex flex-col">
                        <input
                          type="text"
                          value={photoDraft.caption}
                          placeholder="Title / Caption"
                          onChange={(e) =>
                            setPhotoDrafts((prev) => ({
                              ...prev,
                              [photo.id]: { ...photoDraft, caption: e.target.value },
                            }))
                          }
                          onBlur={() => handleSavePhotoDetails(photo.id)}
                          className="w-full px-2 py-1 rounded-lg bg-slate-900 border border-slate-800 text-xs font-medium"
                        />
                        <input
                          type="text"
                          value={photoDraft.altText}
                          placeholder="Description / Alt text"
                          onChange={(e) =>
                            setPhotoDrafts((prev) => ({
                              ...prev,
                              [photo.id]: { ...photoDraft, altText: e.target.value },
                            }))
                          }
                          onBlur={() => handleSavePhotoDetails(photo.id)}
                          className="w-full px-2 py-1 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-300"
                        />
                        <div className="text-[10px] text-slate-500 flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-0.5">
                          <span>Added {formatShortDate(photo.createdAt)}</span>
                          <span>· ♥ {pStats.likes}</span>
                          <span>· ↻ {pStats.shares}</span>
                          {photo.width && photo.height && <span>· {photo.width}×{photo.height}</span>}
                        </div>
                        <div className="flex flex-wrap gap-1 text-[11px] pt-1 mt-auto">
                          <button type="button" disabled={idx === 0} onClick={() => handlePhotoAction(photo, 'up')} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40" title="Move earlier">←</button>
                          <button type="button" disabled={idx === selectedAlbum.photos.length - 1} onClick={() => handlePhotoAction(photo, 'down')} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40" title="Move later">→</button>
                          {!isCover && (
                            <button type="button" onClick={() => handlePhotoAction(photo, 'cover')} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700">Cover</button>
                          )}
                          {photo.sha256 && (
                            <button type="button" onClick={() => handlePhotoAction(photo, 'replace')} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700">Replace</button>
                          )}
                          <button type="button" onClick={() => handlePhotoAction(photo, 'delete')} className="px-2 py-1 rounded bg-rose-950/40 hover:bg-rose-900/50 text-rose-300 ml-auto">Delete</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="divide-y divide-slate-800 border border-slate-800 rounded-xl overflow-hidden bg-slate-950">
                {selectedAlbum.photos.map((photo, idx) => {
                  const photoDraft = photoDrafts[photo.id] || { caption: photo.caption, altText: photo.altText };
                  const isCover = selectedAlbum.coverUrl === photo.thumbUrl;
                  const pStats = photoEngagementCounts(photo, siteUrl, endorsements);
                  return (
                    <div key={photo.id} className="p-3 flex flex-wrap md:flex-nowrap items-center gap-3 hover:bg-slate-900/60 transition">
                      <img
                        src={mediaSrc(photo.thumbUrl || photo.url)}
                        alt={photo.altText}
                        className="w-16 h-12 rounded-lg object-cover bg-slate-800 shrink-0"
                      />
                      <div className="flex-1 min-w-[14rem] grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <input
                          type="text"
                          value={photoDraft.caption}
                          placeholder="Title / Caption"
                          onChange={(e) =>
                            setPhotoDrafts((prev) => ({
                              ...prev,
                              [photo.id]: { ...photoDraft, caption: e.target.value },
                            }))
                          }
                          onBlur={() => handleSavePhotoDetails(photo.id)}
                          className="px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs font-medium"
                        />
                        <input
                          type="text"
                          value={photoDraft.altText}
                          placeholder="Description / Alt text"
                          onChange={(e) =>
                            setPhotoDrafts((prev) => ({
                              ...prev,
                              [photo.id]: { ...photoDraft, altText: e.target.value },
                            }))
                          }
                          onBlur={() => handleSavePhotoDetails(photo.id)}
                          className="px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-300"
                        />
                      </div>
                      <div className="text-[11px] text-slate-400 flex flex-wrap items-center gap-3 shrink-0">
                        <span title="Created">{formatShortDate(photo.createdAt)}</span>
                        <span className="text-pink-300">♥ {pStats.likes}</span>
                        <span className="text-sky-300">↻ {pStats.shares}</span>
                        {isCover && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-600/30 text-indigo-300 font-semibold">
                            Cover
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-[11px] shrink-0">
                        <button type="button" disabled={idx === 0} onClick={() => handlePhotoAction(photo, 'up')} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40">↑</button>
                        <button type="button" disabled={idx === selectedAlbum.photos.length - 1} onClick={() => handlePhotoAction(photo, 'down')} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40">↓</button>
                        {!isCover && (
                          <button type="button" onClick={() => handlePhotoAction(photo, 'cover')} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700">Cover</button>
                        )}
                        <button type="button" onClick={() => handlePhotoAction(photo, 'delete')} className="px-2 py-1 rounded bg-rose-950/40 hover:bg-rose-900/50 text-rose-300">Delete</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* External image by URL */}
          <form onSubmit={handleAddPhoto} className="flex flex-wrap gap-2 border-t border-slate-800 pt-4">
            <input
              type="url"
              value={newPhotoUrl}
              onChange={(e) => setNewPhotoUrl(e.target.value)}
              placeholder="Or link an image hosted elsewhere: https://..."
              className="flex-1 min-w-[14rem] px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs"
            />
            <input
              type="text"
              value={newPhotoCaption}
              onChange={(e) => setNewPhotoCaption(e.target.value)}
              placeholder="Caption"
              className="w-40 px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs"
            />
            <button type="submit" className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold">
              Add Link
            </button>
          </form>
        </div>
      </div>
    );
  }

  // =========================================================================
  // ALBUMS OVERVIEW (MAIN MEDIA LIBRARY VIEW)
  // =========================================================================
  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold">Media Library</h2>
          <p className="text-sm text-slate-400 mt-1">
            Select an album to view and manage its photos, or create a new album.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {mediaUsage && (
            <span className="text-xs text-slate-400 px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800">
              {mediaUsage.files} files · {formatBytes(mediaUsage.bytes)}
            </span>
          )}
          <ViewModeToggle mode={albumsViewMode} onChange={setAlbumsMode} ariaLabel="Albums view mode" />
          <button
            type="button"
            onClick={() => setShowNewAlbumForm((v) => !v)}
            className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold inline-flex items-center gap-1.5 shadow"
          >
            <Plus className="w-3.5 h-3.5" />
            New Album
          </button>
        </div>
      </div>

      {/* + New Album Panel */}
      {showNewAlbumForm && (
        <form
          onSubmit={(e) => {
            handleCreateAlbum(e);
            setShowNewAlbumForm(false);
          }}
          className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3"
        >
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-sm flex items-center gap-2">
              <Plus className="w-4 h-4 text-indigo-400" /> New Album
            </h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input
              type="text"
              required
              value={newAlbumTitle}
              onChange={(e) => setNewAlbumTitle(e.target.value)}
              placeholder="Album title"
              className="px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
            />
            <input
              type="text"
              value={newAlbumDesc}
              onChange={(e) => setNewAlbumDesc(e.target.value)}
              placeholder="Description (optional)"
              className="px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-300">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newAlbumPostToFeed}
                  onChange={(e) => setNewAlbumPostToFeed(e.target.checked)}
                />
                Post to feed
              </label>
              <div className="flex items-center gap-2">
                <span>Show on site as:</span>
                {(['card', 'expanded'] as AlbumDisplay[]).map((mode) => (
                  <label key={mode} className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="radio"
                      name="new-album-display"
                      checked={newAlbumDisplay === mode}
                      onChange={() => setNewAlbumDisplay(mode)}
                    />
                    {mode === 'card' ? 'Card' : 'Expanded'}
                  </label>
                ))}
              </div>
            </div>
            <button
              type="submit"
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs"
            >
              Create Album
            </button>
          </div>
        </form>
      )}

      {/* Albums Grid (Card View) or Rows (List View) */}
      {albums.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-10 text-center text-sm text-slate-400">
          No albums yet. Create your first album above to start adding photos.
        </div>
      ) : albumsViewMode === 'cards' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {albums.map((a) => {
            const cover = a.coverUrl || a.photos[0]?.thumbUrl || a.photos[0]?.url || '';
            const stats = albumEngagementCounts(a, siteUrl, endorsements);
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  setSelectedAlbumId(a.id);
                  setAlbumDraft(null);
                  refreshMediaUsage();
                }}
                className="group bg-slate-900 border border-slate-800 hover:border-indigo-500/60 rounded-2xl overflow-hidden text-left transition flex flex-col shadow-sm"
              >
                <div className="relative w-full aspect-[16/10] bg-slate-950 overflow-hidden">
                  {cover ? (
                    <img
                      src={mediaSrc(cover)}
                      alt={a.title}
                      className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-200"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Camera className="w-9 h-9 text-slate-700" />
                    </div>
                  )}
                  <span className="absolute bottom-2 right-2 text-[11px] font-semibold px-2 py-0.5 rounded-lg bg-slate-950/85 border border-slate-700 text-slate-200">
                    {a.photos.length} {a.photos.length === 1 ? 'item' : 'items'}
                  </span>
                </div>
                <div className="p-4 flex-1 flex flex-col gap-2">
                  <div className="font-bold text-base text-white group-hover:text-indigo-300 transition truncate">
                    {a.title}
                  </div>
                  {a.description && (
                    <p className="text-xs text-slate-400 line-clamp-2">{a.description}</p>
                  )}
                  <div className="mt-auto pt-3 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                    <div className="space-y-0.5">
                      <div>Created {formatShortDate(a.createdAt)}</div>
                      <div>Updated {formatRelativeTime(a.updatedAt)}</div>
                    </div>
                    <div className="flex items-center gap-3 font-medium">
                      <span className="inline-flex items-center gap-1 text-pink-300">
                        <Heart className="w-3 h-3" /> {stats.likes}
                      </span>
                      <span className="inline-flex items-center gap-1 text-sky-300">
                        <Share2 className="w-3 h-3" /> {stats.shares}
                      </span>
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden divide-y divide-slate-800">
          {albums.map((a) => {
            const cover = a.coverUrl || a.photos[0]?.thumbUrl || a.photos[0]?.url || '';
            const stats = albumEngagementCounts(a, siteUrl, endorsements);
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  setSelectedAlbumId(a.id);
                  setAlbumDraft(null);
                  refreshMediaUsage();
                }}
                className="w-full p-3.5 hover:bg-slate-800/50 transition text-left flex flex-wrap sm:flex-nowrap items-center gap-4"
              >
                {cover ? (
                  <img src={mediaSrc(cover)} alt="" className="w-16 h-12 rounded-lg object-cover bg-slate-950 shrink-0" />
                ) : (
                  <div className="w-16 h-12 rounded-lg bg-slate-950 flex items-center justify-center shrink-0">
                    <Camera className="w-5 h-5 text-slate-600" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm text-white truncate">{a.title}</div>
                  {a.description && <p className="text-xs text-slate-400 truncate mt-0.5">{a.description}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400 shrink-0">
                  <span className="font-mono text-slate-200">{a.photos.length} items</span>
                  <span className="text-pink-300">♥ {stats.likes}</span>
                  <span className="text-sky-300">↻ {stats.shares}</span>
                  <span className="text-[11px] text-slate-500">Created {formatShortDate(a.createdAt)}</span>
                  <span className="text-[11px] text-slate-500">Updated {formatRelativeTime(a.updatedAt)}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 text-xs text-slate-400 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl">
          <strong className="text-slate-200">Published copies:</strong> Webring Studio publishes
          resized web copies (EXIF/GPS stripped) while keeping originals on this computer.
        </p>
        <button
          type="button"
          onClick={handleForgetPublishHistory}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 shrink-0"
        >
          Re-upload everything at next publish
        </button>
      </div>
    </div>
  );
}
