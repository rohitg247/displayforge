import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Edit2, Trash2, Tv2, Upload, GripVertical, X, Eye, Image, Film, Megaphone, Radio } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { api } from '@/services/api';
import { ActisButton } from '@/components/admin/ActisButton';
import { ActisInput } from '@/components/admin/ActisInput';
import { ActisCard, ActisCardContent } from '@/components/admin/ActisCard';
import { ActisModal } from '@/components/admin/ActisModal';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from '@/components/ui/sonner';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export function AmbientDisplaysPage() {
  const { state } = useApp();
  const [displays, setDisplays] = useState([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingDisplay, setEditingDisplay] = useState(null);
  const [formName, setFormName] = useState('');
  const [formBranch, setFormBranch] = useState('');
  const [formOrientation, setFormOrientation] = useState('landscape');
  const [formAnnouncementLabel, setFormAnnouncementLabel] = useState('Actis welcomes');
  const [formAnnouncementName, setFormAnnouncementName] = useState('');
  const [formAnnouncementTitle, setFormAnnouncementTitle] = useState('');
  const [formAnnouncementEnabled, setFormAnnouncementEnabled] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [mediaItems, setMediaItems] = useState([]);
  const [dragIdx, setDragIdx] = useState(null);
  const [orderDirty, setOrderDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('A');
  const fileInputRef = useRef(null);

  const fetchDisplays = useCallback(async () => {
    try {
      const data = await api.getAmbientDisplays();
      setDisplays(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDisplays(); }, [fetchDisplays]);

  // ✅ CHANGE 1: admin=true so drafts are visible in admin panel
  const fetchMedia = useCallback(async (displayId, playlist = 'A') => {
    setOrderDirty(false);
    try {
      const data = await api.getAmbientDisplay(displayId, playlist, true);
      setMediaItems(data.media || []);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    if (expandedId) {
      fetchMedia(expandedId, activeTab);
    }
  }, [activeTab, expandedId, fetchMedia]);

  const handleCreate = async () => {
    if (!formName.trim()) return;
    try {
      await api.createAmbientDisplay(Number(formBranch), formName, formOrientation);
      toast.success('Display created');
      closeModal();
      fetchDisplays();
    } catch (err) { toast.error(err.message); }
  };

  const handleUpdate = async () => {
    if (!editingDisplay) return;
    try {
      await api.updateAmbientDisplay(editingDisplay.id, {
        name: formName,
        orientation: formOrientation,
        announcement_label: formAnnouncementLabel,
        announcement_name: formAnnouncementName,
        announcement_title: formAnnouncementTitle,
        announcement_enabled: formAnnouncementEnabled ? 1 : 0,
      });
      toast.success('Display updated');
      closeModal();
      fetchDisplays();
    } catch (err) { toast.error(err.message); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this ambient display?')) return;
    try {
      await api.deleteAmbientDisplay(id);
      toast.success('Display deleted');
      if (expandedId === id) setExpandedId(null);
      fetchDisplays();
    } catch (err) { toast.error(err.message); }
  };

  const handleUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length || !expandedId) return;
    try {
      await api.uploadAmbientMedia(expandedId, files, activeTab);
      toast.success('Media uploaded');
      fetchMedia(expandedId, activeTab);
      fetchDisplays();
    } catch (err) { toast.error(err.message); }
    e.target.value = '';
  };

  const handleDeleteMedia = async (mediaId) => {
    try {
      await api.deleteAmbientMedia(mediaId);
      toast.success('Media deleted');
      fetchMedia(expandedId, activeTab);
      fetchDisplays();
    } catch (err) { toast.error(err.message); }
  };

  // ✅ CHANGE 2: replaced handleSetLive with handlePublishAndSetLive
  const handlePublishAndSetLive = async (displayId) => {
    try {
      await api.publishPlaylist(displayId, activeTab);
      toast.success(`Playlist ${activeTab} published`);
      fetchDisplays();
      fetchMedia(displayId, activeTab);
    } catch (err) { toast.error(err.message); }
  };

  const handleDragStart = (idx) => setDragIdx(idx);
  const handleDragOver = (e, idx) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === idx) return;
    const reordered = [...mediaItems];
    const [moved] = reordered.splice(dragIdx, 1);
    reordered.splice(idx, 0, moved);
    setMediaItems(reordered);
    setDragIdx(idx);
    setOrderDirty(true);
  };
  const handleDragEnd = () => setDragIdx(null);

  const handleSaveOrder = async () => {
    try {
      await api.reorderAmbientMedia(expandedId, mediaItems.map((m) => m.id));
      setOrderDirty(false);
      toast.success('Order saved');
    } catch (err) { toast.error(err.message); }
  };

  const openCreate = () => {
    setEditingDisplay(null);
    setFormName('');
    setFormBranch(state.branches[0]?.id || '');
    setFormOrientation('landscape');
    setFormAnnouncementLabel('Actis welcomes');
    setFormAnnouncementName('');
    setFormAnnouncementTitle('');
    setFormAnnouncementEnabled(false);
    setIsModalOpen(true);
  };

  const openEdit = (d) => {
    setEditingDisplay(d);
    setFormName(d.name);
    setFormBranch(d.branch_id);
    setFormOrientation(d.orientation);
    setFormAnnouncementLabel(d.announcement_label || 'Actis welcomes');
    setFormAnnouncementName(d.announcement_name || '');
    setFormAnnouncementTitle(d.announcement_title || '');
    setFormAnnouncementEnabled(!!d.announcement_enabled);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingDisplay(null);
  };

  const toggleExpand = (id) => {
    if (expandedId === id) {
      setExpandedId(null);
    } else {
      setExpandedId(id);
      setActiveTab('A');
      fetchMedia(id, 'A');
    }
  };

  const branchMap = {};
  state.branches.forEach((b) => { branchMap[b.id] = b.name; });

  const grouped = {};
  displays.forEach((d) => {
    const key = d.branch_id;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(d);
  });

  return (
    <div className="max-w-6xl mx-auto animate-fade-in">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-3xl font-bold text-foreground tracking-tight">Ambient Displays</h2>
          <p className="text-muted-foreground mt-1">Manage ambient display screens and media</p>
        </div>
        <ActisButton variant="primary" onClick={openCreate}>
          <Plus size={18} /> Add Ambient Display
        </ActisButton>
      </div>

      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : displays.length === 0 ? (
        <p className="text-muted-foreground">No ambient displays yet. Create one to get started.</p>
      ) : (
        Object.entries(grouped).map(([branchId, branchDisplays], bIdx) => (
          <motion.div
            key={branchId}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: bIdx * 0.1 }}
            className="mb-10"
          >
            <div className="flex items-center gap-2 mb-4">
              <div className="w-1.5 h-6 rounded-full gradient-accent" />
              <h3 className="text-lg font-bold text-foreground">
                {branchMap[branchId] || `Branch ${branchId}`}
              </h3>
            </div>

            <div className="space-y-3">
              {branchDisplays.map((display) => (
                <div key={display.id}>
                  <ActisCard hover>
                    <ActisCardContent className="flex items-center justify-between p-4">
                      <div
                        className="flex items-center gap-3 flex-1 cursor-pointer"
                        onClick={() => toggleExpand(display.id)}
                      >
                        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                          <Tv2 size={16} className="text-primary" />
                        </div>
                        <div>
                          <p className="font-semibold text-foreground">{display.name}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
                              {display.orientation}
                            </span>
                            <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                              Live: {display.active_playlist || 'A'}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {display.media_count} media
                            </span>
                            {!!display.announcement_enabled && (
                              <Megaphone size={12} className="text-accent" />
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <ActisButton
                          variant="outline"
                          size="sm"
                          onClick={() => window.open(`/ambient/${display.id}?preview=true&playlist=${activeTab}`, '_blank')}
                        >
                          <Eye size={14} /> Preview
                        </ActisButton>
                        <ActisButton
                          variant="outline"
                          size="sm"
                          onClick={() => window.open(`/ambient/${display.id}`, '_blank')}
                        >
                          <Tv2 size={14} /> View
                        </ActisButton>
                        <ActisButton variant="outline" size="sm" onClick={() => openEdit(display)}>
                          <Edit2 size={14} /> Edit
                        </ActisButton>
                        <ActisButton variant="danger" size="sm" onClick={() => handleDelete(display.id)}>
                          <Trash2 size={14} />
                        </ActisButton>
                      </div>
                    </ActisCardContent>
                  </ActisCard>

                  <AnimatePresence>
                    {expandedId === display.id && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden"
                      >
                        <div className="mt-2 p-4 rounded-lg border border-border bg-card/50">
                          <div className="flex items-center justify-between mb-4">
                            <div className="flex items-center gap-2">
                              {['A', 'B'].map((tab) => (
                                <button
                                  key={tab}
                                  onClick={() => setActiveTab(tab)}
                                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                                    activeTab === tab
                                      ? 'gradient-primary text-primary-foreground glow-primary'
                                      : 'bg-secondary text-muted-foreground hover:text-foreground'
                                  }`}
                                >
                                  Playlist {tab}
                                </button>
                              ))}
                              {/* ✅ CHANGE 2: Publish & Set Live replaces Set Live */}
                              {display.active_playlist !== activeTab && (
                                <ActisButton
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handlePublishAndSetLive(display.id)}
                                  className="ml-2"
                                >
                                  <Radio size={14} /> Publish {activeTab} Live
                                </ActisButton>
                              )}
                              {display.active_playlist === activeTab && (
                                <span className="ml-2 text-xs px-2 py-1 rounded-full bg-accent/20 text-accent font-medium">
                                  ● LIVE
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              {orderDirty && (
                                <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 font-medium">
                                  Unsaved order
                                </span>
                              )}
                              <ActisButton variant="outline" size="sm" onClick={handleSaveOrder}>
                                Save Order
                              </ActisButton>
                              <ActisButton
                                variant="primary"
                                size="sm"
                                onClick={() => fileInputRef.current?.click()}
                              >
                                <Upload size={14} /> Upload
                              </ActisButton>
                              <input
                                ref={fileInputRef}
                                type="file"
                                multiple
                                accept="image/*,video/mp4,video/webm"
                                className="hidden"
                                onChange={handleUpload}
                              />
                            </div>
                          </div>

                          {mediaItems.length === 0 ? (
                            <p className="text-muted-foreground text-sm">No media in Playlist {activeTab}.</p>
                          ) : (
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                              {mediaItems.map((item, idx) => (
                                <div
                                  key={item.id}
                                  draggable
                                  onDragStart={() => handleDragStart(idx)}
                                  onDragOver={(e) => handleDragOver(e, idx)}
                                  onDragEnd={handleDragEnd}
                                  className={`relative group rounded-lg border border-border overflow-hidden bg-secondary/50 cursor-grab ${
                                    dragIdx === idx ? 'opacity-50 ring-2 ring-primary' : ''
                                  }`}
                                >
                                  <div className="absolute top-1 left-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <GripVertical size={14} className="text-foreground/70" />
                                  </div>
                                  <button
                                    onClick={() => handleDeleteMedia(item.id)}
                                    className="absolute top-1 right-1 z-10 w-6 h-6 rounded-full bg-destructive/80 text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                                  >
                                    <X size={12} />
                                  </button>

                                  {/* ✅ CHANGE 3: DRAFT badge */}
                                  {item.status === 'draft' && (
                                    <span className="absolute bottom-8 left-1 text-[9px] px-1.5 py-0.5 rounded bg-yellow-500/80 text-black font-bold z-10">
                                      DRAFT
                                    </span>
                                  )}

                                  {item.media_type === 'image' ? (
                                    <img
                                      src={`${API_BASE}${item.file_path}`}
                                      alt=""
                                      className="w-full h-28 object-cover"
                                    />
                                  ) : (
                                    <div className="w-full h-28 flex items-center justify-center bg-secondary">
                                      <Film size={24} className="text-muted-foreground" />
                                    </div>
                                  )}
                                  <div className="px-2 py-1 flex items-center gap-1">
                                    {item.media_type === 'image' ? (
                                      <Image size={10} className="text-muted-foreground" />
                                    ) : (
                                      <Film size={10} className="text-muted-foreground" />
                                    )}
                                    <span className="text-[10px] text-muted-foreground truncate">
                                      {item.file_path.split('/').pop()}
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              ))}
            </div>
          </motion.div>
        ))
      )}

      <ActisModal
        isOpen={isModalOpen}
        onClose={closeModal}
        title={editingDisplay ? 'Edit Ambient Display' : 'Add Ambient Display'}
      >
        <div className="space-y-4">
          {!editingDisplay && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">Branch</label>
              <select
                value={formBranch}
                onChange={(e) => setFormBranch(e.target.value)}
                className="w-full px-4 py-2.5 rounded-lg border border-border bg-input text-foreground focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 transition-all duration-200"
              >
                {state.branches.map((b) => (
                  <option key={b.id} value={b.id} className="bg-card">{b.name}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-foreground mb-2">Name</label>
            <ActisInput
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="Enter display name"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-2">Orientation</label>
            <div className="flex gap-2">
              {['landscape', 'portrait'].map((o) => (
                <button
                  key={o}
                  onClick={() => setFormOrientation(o)}
                  className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                    formOrientation === o
                      ? 'gradient-primary text-primary-foreground glow-primary'
                      : 'bg-secondary text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {o.charAt(0).toUpperCase() + o.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {editingDisplay && (
            <>
              <div className="border-t border-border pt-4 mt-4">
                <p className="text-sm font-semibold text-foreground mb-3">Announcement Settings</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Label</label>
                <ActisInput
                  value={formAnnouncementLabel}
                  onChange={(e) => setFormAnnouncementLabel(e.target.value)}
                  placeholder="e.g. Actis welcomes"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Name</label>
                <ActisInput
                  value={formAnnouncementName}
                  onChange={(e) => setFormAnnouncementName(e.target.value)}
                  placeholder="e.g. Mr. Samba Moorthy"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Title</label>
                <ActisInput
                  value={formAnnouncementTitle}
                  onChange={(e) => setFormAnnouncementTitle(e.target.value)}
                  placeholder="e.g. President - EPSON INDIA"
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setFormAnnouncementEnabled(!formAnnouncementEnabled)}
                  className={`w-10 h-6 rounded-full transition-all duration-200 relative ${
                    formAnnouncementEnabled ? 'bg-accent' : 'bg-secondary'
                  }`}
                >
                  <span
                    className={`absolute top-1 w-4 h-4 rounded-full bg-foreground transition-all duration-200 ${
                      formAnnouncementEnabled ? 'left-5' : 'left-1'
                    }`}
                  />
                </button>
                <span className="text-sm text-foreground">Enable Announcement</span>
              </div>
            </>
          )}

          <div className="flex gap-2 pt-4">
            <ActisButton
              variant="primary"
              onClick={editingDisplay ? handleUpdate : handleCreate}
              className="flex-1"
            >
              {editingDisplay ? 'Update' : 'Add'}
            </ActisButton>
            <ActisButton variant="outline" onClick={closeModal} className="flex-1">
              Cancel
            </ActisButton>
          </div>
        </div>
      </ActisModal>
    </div>
  );
}
