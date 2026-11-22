import React, { useMemo, useState } from 'react';
import { ImagePlus, Pencil, Plus, Search, Sparkles, Trash2, X } from 'lucide-react';
import { EndorsementItem, SharedItem, SharedItemType } from '../shared/schema';
import { renderMarkdown } from '../shared/markdown';
import { MarkdownField } from './MarkdownField';
import { ItemEdit, ItemEditor } from './ItemEditor';
import { StudioViewMode, ViewModeToggle, loadViewMode, saveViewMode } from './ViewModeToggle';
import { ItemFilterType, filterAndSortItems } from './studioFilters';

export interface PostsLibraryViewProps {
  items: SharedItem[];
  endorsements: EndorsementItem[];
  itemType: SharedItemType;
  setItemType: (t: SharedItemType) => void;
  itemCategory: string;
  setItemCategory: (v: string) => void;
  itemRating: number;
  setItemRating: (v: number) => void;
  itemTitle: string;
  setItemTitle: (v: string) => void;
  itemTargetUrl: string;
  setItemTargetUrl: (v: string) => void;
  itemAuthorName: string;
  setItemAuthorName: (v: string) => void;
  itemAuthorUrl: string;
  setItemAuthorUrl: (v: string) => void;
  itemMediaUrl: string;
  setItemMediaUrl: (v: string) => void;
  itemCommentary: string;
  setItemCommentary: (v: string) => void;
  itemTags: string;
  setItemTags: (v: string) => void;
  handlePickLocalPostImage: () => void;
  handleCreateItem: (e: React.FormEvent) => Promise<void> | void;
  editingItemId: string | null;
  setEditingItemId: (id: string | null) => void;
  handleSaveItemEdit: (item: SharedItem, edit: ItemEdit) => Promise<void>;
  handleDeleteItem: (item: SharedItem) => void;
  mediaSrc: (url: string) => string;
  onPickEditImage: () => Promise<string | null>;
}

const TYPE_META: Record<SharedItemType, { label: string; badgeClass: string }> = {
  post: { label: 'Wall Post', badgeClass: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' },
  like: { label: 'Like', badgeClass: 'bg-pink-500/20 text-pink-300 border border-pink-500/30' },
  share: { label: 'Share', badgeClass: 'bg-sky-500/20 text-sky-300 border border-sky-500/30' },
  recommendation: { label: 'Recommend', badgeClass: 'bg-amber-500/20 text-amber-300 border border-amber-500/30' },
  comment: { label: 'Comment', badgeClass: 'bg-purple-500/20 text-purple-300 border border-purple-500/30' },
};

function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function PostsLibraryView(props: PostsLibraryViewProps) {
  const {
    items,
    endorsements,
    itemType,
    setItemType,
    itemCategory,
    setItemCategory,
    itemRating,
    setItemRating,
    itemTitle,
    setItemTitle,
    itemTargetUrl,
    setItemTargetUrl,
    itemAuthorName,
    setItemAuthorName,
    itemAuthorUrl,
    setItemAuthorUrl,
    itemMediaUrl,
    setItemMediaUrl,
    itemCommentary,
    setItemCommentary,
    itemTags,
    setItemTags,
    handlePickLocalPostImage,
    handleCreateItem,
    editingItemId,
    setEditingItemId,
    handleSaveItemEdit,
    handleDeleteItem,
    mediaSrc,
    onPickEditImage,
  } = props;

  const [filterType, setFilterType] = useState<ItemFilterType>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<StudioViewMode>(() => loadViewMode('studio-items-view', 'list'));
  const [engageOpen, setEngageOpen] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  const changeViewMode = (mode: StudioViewMode) => {
    setViewMode(mode);
    saveViewMode('studio-items-view', mode);
  };

  const filteredItems = useMemo(
    () => filterAndSortItems(items, filterType, searchQuery),
    [items, filterType, searchQuery]
  );

  const selectedItem = selectedItemId ? items.find((i) => i.id === selectedItemId) || null : null;

  const onEngageSubmit = async (e: React.FormEvent) => {
    await handleCreateItem(e);
    setEngageOpen(false);
  };

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      {/* Header + Engage CTA */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold">Posts, Likes &amp; Shares</h2>
          <p className="text-sm text-slate-400 mt-1">
            Chronological log of your signed wall posts, likes, shares, recommendations, and comments.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ViewModeToggle mode={viewMode} onChange={changeViewMode} ariaLabel="Posts view mode" />
          <button
            type="button"
            onClick={() => setEngageOpen(true)}
            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs inline-flex items-center gap-1.5 shadow shadow-indigo-600/25"
          >
            <Plus className="w-4 h-4" />
            Engage
          </button>
        </div>
      </div>

      {/* Filter Pills & Search Bar */}
      <div className="flex flex-wrap items-center gap-3 p-3 rounded-2xl bg-slate-900 border border-slate-800">
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              { id: 'all', label: 'All' },
              { id: 'post', label: 'Posts' },
              { id: 'like', label: 'Likes' },
              { id: 'share', label: 'Shares' },
              { id: 'recommendation', label: 'Recommends' },
              { id: 'comment', label: 'Comments' },
            ] as Array<{ id: ItemFilterType; label: string }>
          ).map((f) => {
            const count = f.id === 'all' ? items.length : items.filter((i) => i.type === f.id).length;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilterType(f.id)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition inline-flex items-center gap-1.5 ${
                  filterType === f.id
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
                }`}
              >
                <span>{f.label}</span>
                <span className="text-[10px] opacity-75 font-mono">{count}</span>
              </button>
            );
          })}
        </div>

        <div className="relative flex-1 min-w-[12rem]">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search posts, likes, shares, tags…"
            className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-indigo-500"
          />
        </div>
      </div>

      {/* Chronological List (Default) or Card Grid */}
      {filteredItems.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-10 text-center text-sm text-slate-400">
          {items.length === 0
            ? 'No posts, likes, or shares yet. Click Engage to create your first one.'
            : 'No items match the current filter or search.'}
        </div>
      ) : viewMode === 'list' ? (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden divide-y divide-slate-800">
          {filteredItems.map((item) => {
            const meta = TYPE_META[item.type] || TYPE_META.post;
            const commentCount = endorsements.filter(
              (e) => e.targetCanonicalUrl === item.canonicalUrl && e.type === 'comment'
            ).length;
            return (
              <div
                key={item.id}
                className="p-3.5 hover:bg-slate-800/40 transition flex flex-wrap sm:flex-nowrap items-center gap-3"
              >
                <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-full shrink-0 ${meta.badgeClass}`}>
                  {meta.label}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setEditingItemId(null);
                    setSelectedItemId(item.id);
                  }}
                  className="flex-1 min-w-0 text-left"
                >
                  <div className="font-semibold text-sm text-white hover:text-indigo-300 transition truncate">
                    {item.title}
                  </div>
                  {item.commentary && (
                    <p className="text-xs text-slate-400 truncate mt-0.5">{item.commentary}</p>
                  )}
                </button>
                <div className="flex items-center gap-3 text-[11px] text-slate-500 shrink-0">
                  {commentCount > 0 && <span className="text-emerald-400">💬 {commentCount}</span>}
                  <span>{formatDate(item.createdAt)}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedItemId(item.id);
                      setEditingItemId(item.id);
                    }}
                    className="text-slate-500 hover:text-indigo-300"
                    title="Edit"
                    aria-label={`Edit ${item.title}`}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteItem(item)}
                    className="text-slate-500 hover:text-rose-400"
                    title="Delete"
                    aria-label={`Delete ${item.title}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredItems.map((item) => {
            const meta = TYPE_META[item.type] || TYPE_META.post;
            const commentCount = endorsements.filter(
              (e) => e.targetCanonicalUrl === item.canonicalUrl && e.type === 'comment'
            ).length;
            return (
              <div
                key={item.id}
                className="bg-slate-900 border border-slate-800 hover:border-indigo-500/50 rounded-2xl p-4 flex flex-col justify-between transition"
              >
                <button
                  type="button"
                  onClick={() => {
                    setEditingItemId(null);
                    setSelectedItemId(item.id);
                  }}
                  className="text-left space-y-2 flex-1"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-full ${meta.badgeClass}`}>
                      {meta.label}
                    </span>
                    <span className="text-[11px] text-slate-500">{formatDate(item.createdAt)}</span>
                  </div>
                  {item.mediaUrl && (
                    <img
                      src={mediaSrc(item.mediaUrl)}
                      alt={item.title}
                      className="w-full h-32 object-cover rounded-xl bg-slate-950"
                    />
                  )}
                  <h4 className="font-bold text-sm text-white line-clamp-2">{item.title}</h4>
                  {item.commentary && (
                    <p className="text-xs text-slate-400 line-clamp-3 whitespace-pre-line">{item.commentary}</p>
                  )}
                </button>
                <div className="mt-3 pt-2.5 border-t border-slate-800 flex items-center justify-between text-[11px] text-slate-500">
                  <span className="truncate">{commentCount > 0 ? `💬 ${commentCount} · ` : ''}{item.category}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedItemId(item.id);
                        setEditingItemId(item.id);
                      }}
                      className="text-slate-500 hover:text-indigo-300"
                      title="Edit"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteItem(item)}
                      className="text-slate-500 hover:text-rose-400"
                      title="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Complete Item Detail / Editor Modal */}
      {selectedItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl bg-slate-900 border border-slate-700 p-6 shadow-2xl space-y-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className={`text-[11px] uppercase font-bold px-2.5 py-0.5 rounded-full ${(TYPE_META[selectedItem.type] || TYPE_META.post).badgeClass}`}>
                  {(TYPE_META[selectedItem.type] || TYPE_META.post).label}
                </span>
                <span className="text-xs text-slate-500">{formatDate(selectedItem.createdAt)}</span>
                {selectedItem.updatedAt && <span className="text-[11px] text-slate-500">(edited)</span>}
              </div>
              <div className="flex items-center gap-2">
                {editingItemId !== selectedItem.id && (
                  <button
                    type="button"
                    onClick={() => setEditingItemId(selectedItem.id)}
                    className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 inline-flex items-center gap-1"
                  >
                    <Pencil className="w-3.5 h-3.5" /> Edit
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    handleDeleteItem(selectedItem);
                    setSelectedItemId(null);
                  }}
                  className="px-2.5 py-1 rounded-lg bg-rose-950/50 hover:bg-rose-900/60 text-xs text-rose-300 inline-flex items-center gap-1"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Delete
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingItemId(null);
                    setSelectedItemId(null);
                  }}
                  className="p-1 rounded-lg text-slate-400 hover:bg-slate-800"
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {editingItemId === selectedItem.id ? (
              <ItemEditor
                item={selectedItem}
                mediaSrc={mediaSrc}
                onPickImage={onPickEditImage}
                onSave={async (edit) => {
                  await handleSaveItemEdit(selectedItem, edit);
                }}
                onCancel={() => setEditingItemId(null)}
              />
            ) : (
              <div className="space-y-3">
                <h3 className="text-xl font-bold text-white">{selectedItem.title}</h3>
                {selectedItem.targetUrl && selectedItem.targetUrl !== selectedItem.canonicalUrl && (
                  <p className="text-xs text-indigo-400 font-mono break-all">Target: {selectedItem.targetUrl}</p>
                )}
                {selectedItem.mediaUrl && (
                  <img
                    src={mediaSrc(selectedItem.mediaUrl)}
                    alt={selectedItem.title}
                    className="w-full max-h-80 object-cover rounded-xl bg-slate-950"
                  />
                )}
                {selectedItem.type === 'post' ? (
                  <div
                    className="studio-prose text-sm text-slate-200"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(selectedItem.commentary) }}
                  />
                ) : (
                  <p className="text-sm text-slate-200 whitespace-pre-line">{selectedItem.commentary}</p>
                )}
                {selectedItem.tags && selectedItem.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-2">
                    {selectedItem.tags.map((t) => (
                      <span key={t} className="text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">
                        #{t}
                      </span>
                    ))}
                  </div>
                )}
                {(() => {
                  const postComments = endorsements.filter(
                    (e) => e.targetCanonicalUrl === selectedItem.canonicalUrl && e.type === 'comment'
                  );
                  if (postComments.length === 0) return null;
                  return (
                    <div className="pt-3 border-t border-slate-800 space-y-1.5">
                      <p className="text-xs font-bold text-emerald-400">
                        💬 Discovered Ring Comments ({postComments.length})
                      </p>
                      {postComments.map((c) => (
                        <div key={c.id} className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-xs">
                          <span className="font-bold text-indigo-300">{c.authorName}: </span>
                          <span className="text-slate-300">{c.commentary}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
                <div className="pt-3 border-t border-slate-800 flex items-center justify-between text-[11px] text-slate-500 font-mono">
                  <span className="truncate">{selectedItem.canonicalUrl}</span>
                  <span>{selectedItem.category}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Engage Popup Compose Modal */}
      {engageOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="engage-modal-title"
            className="w-full max-w-2xl max-h-[88vh] overflow-y-auto rounded-2xl bg-slate-900 border border-slate-700 p-6 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between gap-3">
              <h3 id="engage-modal-title" className="font-bold text-base flex items-center gap-2 text-white">
                <Sparkles className="w-4 h-4 text-amber-400" />
                Create Engagement
              </h3>
              <button
                type="button"
                onClick={() => setEngageOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={onEngageSubmit} className="space-y-4">
              {/* Engagement Type Selector Pills */}
              <div className="flex flex-wrap gap-1.5 text-xs">
                {(
                  [
                    { id: 'post', label: '📝 Wall Post' },
                    { id: 'like', label: '♥ Like' },
                    { id: 'share', label: '↻ Share' },
                    { id: 'recommendation', label: '★ Recommend' },
                    { id: 'comment', label: '💬 Comment' },
                  ] as const
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      setItemType(m.id);
                      if (m.id === 'post') setItemCategory('status');
                      if (m.id === 'comment') setItemCategory('comment');
                    }}
                    className={`px-3 py-1.5 rounded-lg font-semibold transition ${
                      itemType === m.id
                        ? 'bg-indigo-600 text-white shadow'
                        : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              {itemType === 'post' ? (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="md:col-span-2">
                      <label className="block text-xs text-slate-400 mb-1">
                        Headline / Title (optional)
                      </label>
                      <input
                        type="text"
                        value={itemTitle}
                        onChange={(e) => setItemTitle(e.target.value)}
                        placeholder="e.g., Weekend Darkroom Notes"
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Category</label>
                      <select
                        value={itemCategory}
                        onChange={(e) => setItemCategory(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                      >
                        <option value="status">Status Update</option>
                        <option value="article">Essay / Micro-Blog</option>
                        <option value="photo">Photo Post</option>
                        <option value="music">Music / Audio</option>
                        <option value="general">General</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Post Body *</label>
                    <MarkdownField
                      value={itemCommentary}
                      onChange={setItemCommentary}
                      rows={5}
                      placeholder="Write your update or story here (Markdown supported)…"
                    />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="md:col-span-2">
                      <label className="block text-xs text-slate-400 mb-1">Photo / Media URL (optional)</label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={itemMediaUrl}
                          onChange={(e) => setItemMediaUrl(e.target.value)}
                          placeholder="https://... or import local image"
                          className="flex-1 px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                        />
                        <button
                          type="button"
                          onClick={handlePickLocalPostImage}
                          className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium inline-flex items-center gap-1.5 shrink-0"
                        >
                          <ImagePlus className="w-4 h-4 text-indigo-400" />
                          Import
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Tags</label>
                      <input
                        type="text"
                        value={itemTags}
                        onChange={(e) => setItemTags(e.target.value)}
                        placeholder="status, update"
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                      />
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Category</label>
                      <select
                        value={itemCategory}
                        onChange={(e) => setItemCategory(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                      >
                        <option value="comment">Comment / Reply</option>
                        <option value="article">Article / Essay</option>
                        <option value="photo">Photo / Visual Art</option>
                        <option value="music">Music / Audio</option>
                        <option value="book">Book / Zine</option>
                        <option value="gear">Tool / Hardware / Gear</option>
                        <option value="general">General Web Item</option>
                      </select>
                    </div>
                    {itemType !== 'comment' && (
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Rating</label>
                        <select
                          value={itemRating}
                          onChange={(e) => setItemRating(Number(e.target.value))}
                          className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                        >
                          <option value={5}>★★★★★ (5/5)</option>
                          <option value={4}>★★★★☆ (4/5)</option>
                          <option value={3}>★★★☆☆ (3/5)</option>
                          <option value={2}>★★☆☆☆ (2/5)</option>
                          <option value={1}>★☆☆☆☆ (1/5)</option>
                        </select>
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">
                        {itemType === 'comment' ? 'Subject / Replying To' : 'Item Title *'}
                      </label>
                      <input
                        type="text"
                        required={itemType !== 'comment'}
                        value={itemTitle}
                        onChange={(e) => setItemTitle(e.target.value)}
                        placeholder={itemType === 'comment' ? 'Re: Friend’s post' : 'Title of the item'}
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Target URL *</label>
                      <input
                        type="text"
                        required
                        value={itemTargetUrl}
                        onChange={(e) => setItemTargetUrl(e.target.value)}
                        placeholder="https://friend.example/..."
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Author Name</label>
                      <input
                        type="text"
                        value={itemAuthorName}
                        onChange={(e) => setItemAuthorName(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Author Site URL</label>
                      <input
                        type="text"
                        value={itemAuthorUrl}
                        onChange={(e) => setItemAuthorUrl(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Preview Image URL</label>
                      <input
                        type="text"
                        value={itemMediaUrl}
                        onChange={(e) => setItemMediaUrl(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="md:col-span-2">
                      <label className="block text-xs text-slate-400 mb-1">
                        {itemType === 'comment' ? 'Comment / Reply *' : 'Commentary / Notes'}
                      </label>
                      <textarea
                        rows={3}
                        required={itemType === 'comment'}
                        value={itemCommentary}
                        onChange={(e) => setItemCommentary(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Tags</label>
                      <input
                        type="text"
                        value={itemTags}
                        onChange={(e) => setItemTags(e.target.value)}
                        placeholder="indieweb, synth"
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                      />
                    </div>
                  </div>
                </>
              )}

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setEngageOpen(false)}
                  className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs shadow"
                >
                  Submit Engagement
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
